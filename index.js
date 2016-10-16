var runProcessWithOutput = require('orchestration-util-process').runProcessWithOutput;
var runProcessWithOutputAndWorkingDirectory = require('orchestration-util-process').runProcessWithOutputAndWorkingDirectory;
var spawn = require('child_process').spawn;
var fs = require('fs');
var ncp = require('ncp').ncp;
var async = require('async');
var targz = require('tar.gz');
var mkdirp = require('mkdirp');
var path = require('path');
var rimraf = require('rimraf');

ncp.limit = 16;

function getDockerfile(config, environment) {
  var version = config.dockerImageVersion || config.package.version;

  if (config.orchestration.packageType == 'custom-dockerfile') {
    var file = fs.readFileSync(config.orchestration.packageDockerFile, 'utf8');
    file = file.replace(/\$ENVIRONMENT/, environment);
    return file;
  }

  if (config.orchestration.packageType == null || config.orchestration.packageType == 'nodejs') {
    var dockerfile = `
FROM node:latest
WORKDIR /srv`
    if (config.orchestration.privateRepoKey != null) {
      dockerfile += `
ADD ` + config.orchestration.privateRepoKey + ` /root/.ssh/id_rsa
RUN chmod 0600 /root/.ssh/id_rsa`
    }
    if (config.orchestration.privateRepoHosts != null) {
      for (var i = 0; i < config.orchestration.privateRepoHosts.length; i++) {
        dockerfile += `
RUN bash -c 'ssh-keyscan -H ` + config.orchestration.privateRepoHosts[i] + ` >> ~/.ssh/known_hosts'`
      }
    }
    dockerfile += `
ADD package.json.versionless /srv/package.json
RUN npm install --production`
    if (config.orchestration.privateRepoKey != null) {
      dockerfile += `
RUN rm /root/.ssh/id_rsa`
    }
    dockerfile += `
ADD package.json /srv/package.json
`;
  } else if (config.orchestration.packageType == 'custom') {
    var dockerfile = `
FROM ` + config.orchestration.packageBase + `
WORKDIR /srv
`;
  } else {
    throw 'Unknown or not supported package type: ' + config.orchestration.packageType + '.'
  }

  if (config.orchestration.packageType == 'custom' && config.orchestration.packagePreCommands != null) {
    for (var i = 0; i < config.orchestration.packagePreCommands.length; i++) {
      dockerfile += "RUN " + config.orchestration.packagePreCommands[i] + "\n";
    }
  }

  for (var i = 0; i < config.orchestration.files.length; i++) {
    var value = config.orchestration.files[i];
    if (typeof value == "string") {
      // Always include
      dockerfile += "ADD " + value + " /srv/" + value + "\n";
    } else {
      if (value.env == environment) {
        dockerfile += "ADD " + value.name + " /srv/" + value.name + "\n";
      }
    }
  }

  if (config.orchestration.services != null) {
    for (var i = 0; i < config.orchestration.services.length; i++) {
      var value = config.orchestration.services[i][environment];
      dockerfile += "EXPOSE " + value.containerPort + "\n";
    }
  }

  if (config.orchestration.packageType == 'custom' && config.orchestration.packagePostCommands != null) {
    for (var i = 0; i < config.orchestration.packagePostCommands.length; i++) {
      dockerfile += "RUN " + config.orchestration.packagePostCommands[i] + "\n";
    }
  }

  dockerfile += "RUN echo \"" + version + "\" > /docker-image-version.txt\n"

  if (config.orchestration.packageType == null || config.orchestration.packageType == 'nodejs') {
    dockerfile += "CMD NODE_ENV=" + environment + " node " + config.package.main;
  } else if (config.orchestration.packageType == 'custom') {
    dockerfile += "CMD " + config.orchestration.packageEnvironmentVariable + "=" + environment + " " + config.orchestration.packageRun;
  }

  return dockerfile;
}

function getVersionlessPackageJson(callback) {
  // Convert to JSON and parse again to get a copy.
  var packageInfo = JSON.parse(JSON.stringify(require(process.cwd() + '/package.json')));
  packageInfo.version = "1.0.0";

  // If any of the packages of this module are Git repositories, we should
  // inspect those packages (we assume `npm install` has been run for them)
  // and find their package versions.  We then embed those versions as metadata
  // into the versionless file.
  //
  // When you add a Git repository as a dependency in NPM, it doesn't contain
  // a version number which changes.  Without including this version information here
  // manually, Docker will consider the packages unchanged, even when new commits
  // have been pushed to those repositories.
  var gitVersionsMetadata = {}
  var didAddMetadata = false;
  if (packageInfo.dependencies) {
    for (var key in packageInfo.dependencies) {
      if (packageInfo.dependencies.hasOwnProperty(key)) {
        if (packageInfo.dependencies[key].startsWith("git+")) {
          var path = process.cwd() + "/node_modules/" + key + "/package.json";
          try {
            var depInfo = require(path);
            gitVersionsMetadata[key] = depInfo.version;
            didAddMetadata = true;
          } catch (e) {
            console.log('unable to determine version of Git dependency: ' + path);
          }
        }
      }
    }
  }
  if (packageInfo.devDependencies) {
    for (var key in packageInfo.devDependencies) {
      if (packageInfo.devDependencies.hasOwnProperty(key)) {
        if (packageInfo.devDependencies[key].startsWith("git+")) {
          var path = process.cwd() + "/node_modules/" + key + "/package.json";
          try {
            var depInfo = require(path);
            gitVersionsMetadata[key] = depInfo.version;
            didAddMetadata = true;
          } catch (e) {
            console.log('unable to determine version of Git dependency: ' + path);
          }
        }
      }
    }
  }
  if (didAddMetadata) {
    packageInfo.gitVersionsMetadata = gitVersionsMetadata;
  }

  packageInfo.devDependencies = {};

  return JSON.stringify(packageInfo);
}

function cleanupFile(file, err, callback) {
  fs.unlink(file, (errUnlink) => {
    if (err) {
      callback(err);
    } else if (errUnlink) {
      callback(errUnlink);
    } else {
      callback();
    }
  });
}

function build(config, environment, callback) {
  var version = config.dockerImageVersion || config.package.version;

  var dockerPrefix = config.cluster.environments[environment].dockerImagePrefix;

  fs.writeFile('Dockerfile.tmp', getDockerfile(config, environment), (err) => {
    if (err) { callback(err); return; }

    var cleanupDockerfile = (err) => { cleanupFile('Dockerfile.tmp', err, callback); };

    fs.writeFile('package.json.versionless', getVersionlessPackageJson(), (err) => {
      if (err) {
        cleanupDockerfile(err);
        return;
      }

      var cleanupVersionless = (err) => { cleanupFile('package.json.versionless', err, cleanupDockerfile); };

      runProcessWithOutput(
        'docker',
        [
          'build',
          '-t',
          dockerPrefix + config.package.name + ":" + version,
          '-f',
          'Dockerfile.tmp',
          '.'
        ],
        cleanupVersionless
      );
    });
  });
}

function buildOptimized(config, environment, callback) {
  if (!(config.orchestration.packageType == null || config.orchestration.packageType == 'nodejs')) {
    callback(new Error('buildOptimized only worked on Node.js Docker images'));
    return;
  }

  var version = config.dockerImageVersion || config.package.version;

  var dockerPrefix = config.cluster.environments[environment].dockerImagePrefix;

  if (dockerPrefix == "" || dockerPrefix[dockerPrefix.length - 1] != "/") {
    callback(new Error("Docker prefix in cluster does not end with a slash, refusing to push to potentially public location!"));
    return;
  }

  mkdirp('_docker/bundle', (err) => {
    if (err) {
      callback(err);
      return;
    }

    var createDirectory = function(dir, callback) {
      fs.access(dir, fs.F_OK, (err) => {
        if (err) {
          fs.mkdir(dir, (err) => {
            if (err) {
              callback(err);
              return;
            }

            callback(null);
          });
        } else {
          callback(null);
        }
      });
    };

    var copyAllFilesToWorkingDirectory = function(callback) {
      var filesToCopy = [
        //'node_modules'
      ];

      for (var i = 0; i < config.orchestration.files.length; i++) {
        var value = config.orchestration.files[i];
        if (typeof value == "string") {
          // Always include
          filesToCopy.push(value);
        } else {
          if (value.env == environment) {
            filesToCopy.push(value.name);
          }
        }
      }

      async.map(
        filesToCopy,
        (item, callback) => {
          console.log('copy ' + item + ' ...');
          mkdirp(path.dirname('_docker/bundle/' + item), (err) => {
            if (err) {
              callback(err);
              return;
            }
            
            ncp(item, '_docker/bundle/' + item, {clobber: false, modified: true}, (err) => {
              if (err) {
                callback(err);
                return;
              }

              console.log('copy ' + item + ' done');
              callback();
            });
          });
        },
        callback);
    };

    var copyNpmCacheToWorkingDirectory = function(callback) {
      var cachePath = null;
      if (process.platform == 'win32') {
        cachePath = process.env['APPDATA'] + '\\npm-cache';
      } else {
        cachePath = process.env['HOME'] + '/.npm';
      }

      console.log('copy npm cache ...');
      mkdirp(path.dirname('_docker/bundle/_npmcache'), (err) => {
        if (err) {
          callback(err);
          return;
        }
        
        ncp(cachePath, '_docker/bundle/_npmcache', {clobber: false, modified: true}, (err) => {
          if (err) {
            callback(err);
            return;
          }

          console.log('copy npm cache done');
          callback();
        });
      });
    }
    
    var writeVersionlessFile = function(callback) {
      console.log('write versionless file ...');
      var versionless = getVersionlessPackageJson();

      var writePackageJson = function(callback) {
        fs.writeFile('_docker/bundle/package.json', versionless, (err) => {
          if (err) {
            callback(err);
            return;
          }

          console.log('write versionless file done');
          callback();
        });
      };

      fs.access('_docker/bundle/package.json', fs.F_OK, (err) => {
        if (err) {
          writePackageJson(callback);
        } else {
          fs.readFile('_docker/bundle/package.json', 'utf8', (err, data) => {
            if (err) {
              callback(err);
              return;
            }

            if (data == versionless) {
              console.log('write versionless file done');
              callback();
              return;
            }

            writePackageJson(callback);
          });
        }
      });
    };

    var copyVersionedFile = function(callback) {
      console.log('copy versioned file ...');
      ncp('package.json', '_docker/bundle/package.json.versioned', {clobber: false, modified: true}, (err) => {
        if (err) {
          callback(err);
          return;
        }

        console.log('copy versioned file done');
        callback();
      });
    };

    var copyGitCredentials = function(callback) {
      if (config.orchestration.privateRepoKey != null) {
        console.log('copy git credentials ...');
        ncp(config.orchestration.privateRepoKey, '_docker/bundle/id_rsa', {clobber: false, modified: true}, (err) => {
          if (err) {
            callback(err);
            return;
          }

          console.log('copy git credentials done');
          callback();
        });
      } else {
        callback(null);
      }
    };

    async.parallel([
      writeVersionlessFile,
      copyNpmCacheToWorkingDirectory,
      copyAllFilesToWorkingDirectory,
      copyVersionedFile,
      copyGitCredentials
    ], (err) => {
      if (err) {
        callback(err);
        return;
      }

      console.log('build docker image ...');

      var keyscanCommands = [];
      for (var i = 0; i < config.orchestration.privateRepoHosts.length; i++) {
        keyscanCommands.push("ssh-keyscan -H " + config.orchestration.privateRepoHosts[i] + " >> ~/.ssh/known_hosts");
      }

      var commands = [
        // Copy Git credentials if needed
        '(if [ -e id_rsa ]; then mkdir -pv /root/.ssh; mv id_rsa /root/.ssh/id_rsa; chmod 0600 /root/.ssh/id_rsa; fi)',
        // Perform SSH keyscans for hosts
      ].concat(keyscanCommands).concat([
        // Move cache
        'mv _npmcache /root/.npm',
        'NODE_ENV=production npm install -g npm-offline --production --cache-min 999999',
        '(npm-offline &)',
        'npm config set registry http://localhost:12644/',
        // Install any required modules
        'NODE_ENV=production npm install --production --cache-min 999999',
        // Move versioned file in place
        'mv package.json.versioned package.json',
        // Delete any Git credentials
        '(if [ -e /root/.ssh/id_rsa ]; then rm /root/.ssh/id_rsa; fi)'
      ]);

      var exposeStatements = [];
      if (config.orchestration.services != null) {
        for (var i = 0; i < config.orchestration.services.length; i++) {
          var value = config.orchestration.services[i][environment];
          exposeStatements.push("EXPOSE " + value.containerPort + "\n");
        }
      }

      var dockerfile = `
FROM node:latest
WORKDIR /srv
ADD bundle /srv
RUN ` + commands.join(' && ') + `
` + exposeStatements + `
CMD NODE_ENV=` + environment + ` node ` + config.package.main + `
`;

      fs.writeFile('_docker/Dockerfile', dockerfile, (err) => {
        if (err) {
          callback(err);
          return;
        }

        console.log('wrote docker file, starting docker build ...');

        runProcessWithOutput(
          'docker',
          [
            'build',
            '-t',
            dockerPrefix + config.package.name + ":" + version,
            '_docker'
          ],
          callback
        );
      });
    });
  });
}

function push(config, environment, callback) {
  var version = config.dockerImageVersion || config.package.version;

  var dockerPrefix = config.cluster.environments[environment].dockerImagePrefix;

  if (dockerPrefix == "" || dockerPrefix[dockerPrefix.length - 1] != "/") {
    callback(new Error("Docker prefix in cluster does not end with a slash, refusing to push to potentially public location!"));
    return;
  }

  if (config.cluster.type == "google-cloud-kubernetes") {
    runProcessWithOutput(
      'gcloud',
      [
        '--project=' + config.cluster.environments[environment].project,
        'docker',
        '--',
        'push',
        dockerPrefix + config.package.name + ":" + version,
      ],
      callback
    );
  } else {
    runProcessWithOutput(
      'docker',
      [
        'push',
        dockerPrefix + config.package.name + ":" + version,
      ],
      callback
    );
  }
}

function testLocal(config, environment, devPorts, callback) {
  var version = config.dockerImageVersion || config.package.version;

  var dockerPrefix = config.cluster.environments[environment].dockerImagePrefix;
  var containerName = 'orchestration-test-' + config.package.name;
  var args1 = [
    'run',
    '--rm',
    '--name=' + containerName
  ];
  var args2 = [
    dockerPrefix + config.package.name + ":" + version
  ];
  var argsPorts = [];
  for (var source in devPorts) {
    if (devPorts.hasOwnProperty(source)) {
      argsPorts.push('-p');
      argsPorts.push(source + ":" + devPorts[source]);
    }
  }
  var child = spawn(
    'docker',
    args1.concat(argsPorts).concat(args2),
    {
      env: {
        'NODE_ENV': environment,
      },
      shell: true,
      detached: true
    });
  child.on('exit', (code) => {
    console.log('Stopping container...');
    var stopChild = spawn('docker', [ 'stop', containerName ], { shell: true });
    stopChild.on('exit', (stopCode) => {
      console.log('Removing container...');
      var rmChild = spawn('docker', [ 'rm', containerName ], { shell: true });
      rmChild.on('exit', (rmCode) => {
        callback();
      });      
    });
  });
}

function testLocalOpts(config, environment, opts, callback) {
  var version = config.dockerImageVersion || config.package.version;

  var dockerPrefix = config.cluster.environments[environment].dockerImagePrefix;
  var containerName = 'orchestration-test-' + config.package.name;
  var args1 = [
    'run',
    '--rm',
    '--name=' + containerName
  ];
  var args2 = [
    dockerPrefix + config.package.name + ":" + version
  ];

  var argsPorts = [];
  var argsVolumes = [];
  var argsEnv = [
    '-e',
    'NODE_ENV=' + environment
  ];

  if (opts.ports != null) {
    for (var source in opts.ports) {
      if (opts.ports.hasOwnProperty(source)) {
        argsPorts.push('-p');
        argsPorts.push(source + ":" + opts.ports[source]);
      }
    }
  }

  if (opts.volumes != null) {
    for (var source in opts.volumes) {
      if (opts.volumes.hasOwnProperty(source)) {
        argsVolumes.push('-v');
        argsVolumes.push(source + ":" + opts.volumes[source]);
      }
    }
  }

  if (opts.env != null) {
    for (var source in opts.env) {
      if (opts.env.hasOwnProperty(source)) {
        argsEnv.push('-e');
        argsEnv.push(source + "=" + opts.env[source]);
      }
    }
  }

  var child = spawn(
    'docker',
    args1.concat(argsPorts).concat(argsVolumes).concat(argsEnv).concat(args2),
    {
      shell: true,
      detached: true
    });
  child.on('exit', (code) => {
    console.log('Stopping container...');
    var stopChild = spawn('docker', [ 'stop', containerName ], { shell: true });
    stopChild.on('exit', (stopCode) => {
      console.log('Removing container...');
      var rmChild = spawn('docker', [ 'rm', containerName ], { shell: true });
      rmChild.on('exit', (rmCode) => {
        callback();
      });      
    });
  });
}


module.exports = {
  build: build,
  buildOptimized: buildOptimized,
  push: push,
  testLocal: testLocal,
  testLocalOpts: testLocalOpts
}