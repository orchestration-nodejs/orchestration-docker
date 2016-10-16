var runProcessWithOutput = require('orchestration-util-process').runProcessWithOutput;
var runProcessAndCapture = require('orchestration-util-process').runProcessAndCapture;
var runProcessWithOutputAndWorkingDirectory = require('orchestration-util-process').runProcessWithOutputAndWorkingDirectory;
var spawn = require('child_process').spawn;
var fs = require('fs');
var ncp = require('ncp').ncp;
var async = require('async');
var targz = require('tar.gz');
var mkdirp = require('mkdirp');
var path = require('path');
var rimraf = require('rimraf');
var getVersionlessPackageJson = require('./versionless.js');

ncp.limit = 16;

function declareBuildOptimizedTasks(declarer, name, config, environment, previousTasks) {

  var baseDir = '_docker/' + environment;

  declarer(name + ':root', previousTasks, function(callback) {
    callback();
  })

  declarer(name + ':create-cache-directory', [name + ':root'], function(callback) {
    mkdirp(baseDir + '/cache', callback);
  })

  declarer(name + ':prepare-ssh-keys-for-npm-cache', [name + ':create-cache-directory'], function(callback) {
    if (config.orchestration.privateRepoKey != null) {
      ncp(config.orchestration.privateRepoKey, baseDir + '/cache/id_rsa', {clobber: false, modified: true}, (err) => {
        if (err) {
          callback(err);
          return;
        }

        callback();
      });
    } else {
      callback(null);
    }
  });

  declarer(name + ':write-versionless-file-for-npm-cache', [name + ':create-cache-directory'], function(callback) {
    var versionless = getVersionlessPackageJson();

    fs.writeFile(baseDir + '/cache/package.json', versionless, (err) => {
      if (err) {
        callback(err);
        return;
      }

      callback();
    });
  });

  declarer(
    name + ':update-npm-cache-for-docker-image',
    [
      name + ':prepare-ssh-keys-for-npm-cache',
      name + ':write-versionless-file-for-npm-cache'
    ],
    function(callback) {
      var keyscanCommands = [];
      for (var i = 0; i < config.orchestration.privateRepoHosts.length; i++) {
        keyscanCommands.push("ssh-keyscan -H " + config.orchestration.privateRepoHosts[i] + " >> ~/.ssh/known_hosts");
      }

      var explicitInstalls = [];
      
      var packageInfo = JSON.parse(JSON.stringify(require(process.cwd() + '/' + baseDir + '/cache/package.json')));
      if (packageInfo.dependencies) {
        for (var key in packageInfo.dependencies) {
          if (packageInfo.dependencies.hasOwnProperty(key)) {
            if (packageInfo.dependencies[key].startsWith("git+")) {
              explicitInstalls.push(key);
            }
          }
        }
      }

      if (explicitInstalls.length == 0) {
        explicitInstalls = '';
      } else {
        explicitInstalls = 'npm install --production ' + explicitInstalls.join(' ');
      }

      var script = `
#!/bin/bash

set -e
set -x

pushd /prep

mkdir -pv /root/.ssh;

if [ -e /prep/id_rsa ]; then
  mv /prep/id_rsa /root/.ssh/id_rsa;
  chmod 0600 /root/.ssh/id_rsa;
fi;

` + keyscanCommands.join(";") + `

npm install --production
` + explicitInstalls + `
`

      fs.writeFile(baseDir + '/cache/prepare.sh', script, (err) => {
        if (err) {
          callback(err);
          return;
        }

        runProcessWithOutput(
        'docker',
          [
            'run',
            '--rm',
            '-w',
            '/srv',
            '-e',
            'NODE_ENV=production',
            '-v',
            path.join(process.cwd(), baseDir, 'cache') + ":/prep",
            'node:latest',
            'bash',
            '/prep/prepare.sh'
          ],
          callback
        );
      });
    }
  );

  declarer(name + ':create-srv-directory', [name + ':root'], function(callback) {
    mkdirp(baseDir + '/srv', callback);
  });

  declarer(
    name + ':copy-app-files-to-srv-directory',
    [
      name + ':create-srv-directory'
    ],
    function(callback) {
      var filesToCopy = [];

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
          mkdirp(path.dirname(baseDir + '/srv/' + item), (err) => {
            if (err) {
              callback(err);
              return;
            }
            
            ncp(item, baseDir + '/srv/' + item, {clobber: false, modified: true}, (err) => {
              if (err) {
                callback(err);
                return;
              }

              callback();
            });
          });
        },
        callback);
    }
  );

  declarer(
    name + ':copy-versioned-file-to-srv-directory',
    [
      name + ':create-srv-directory'
    ],
    function(callback) {
      ncp('package.json', baseDir + '/srv/package.json', {clobber: false, modified: true}, (err) => {
        if (err) {
          callback(err);
          return;
        }

        callback();
      });
    }
  );

  declarer(
    name + ':copy-npm-package-bundle-to-srv-directory',
    [
      name + ':create-srv-directory',
      name + ':update-npm-cache-for-docker-image',
    ],
    function(callback) {
      ncp(baseDir + '/cache/node_modules', baseDir + '/srv/node_modules', {clobber: false, modified: true}, (err) => {
        if (err) {
          callback(err);
          return;
        }

        callback();
      });
    }
  );

  var containerId;
  var cleanupContainerThen = function(callback) {
    runProcessWithOutput(
      'docker',
      [
        'rm',
        containerId
      ],
      (_) => {
        callback();
      });
  };

  declarer(
    name + ':create-container',
    [
      name + ':root'
    ],
    function(callback) {
      runProcessAndCapture(
        'docker',
        [
          'create',
          'node:latest'
        ],
        (buffer, err) => {
          if (err) {
            callback(err);
            return;
          }

          containerId = buffer.trim();

          console.log('container id is ' + containerId);

          callback();
        });
    }
  );

  declarer(
    name + ':copy-bundle-files-to-srv',
    [
      name + ':copy-app-files-to-srv-directory',
      name + ':copy-versioned-file-to-srv-directory',
      name + ':copy-npm-package-bundle-to-srv-directory',
      name + ':create-container',
    ],
    function(callback) {
      runProcessWithOutput(
        'docker',
        [
          'cp',
          baseDir + '/srv',
          containerId + ':/'
        ],
        (err) => {
          if (err) {
            cleanupContainerThen(() => callback(err));
            return;
          }

          callback();
        });
    }
  );

  var newImageId;

  declarer(
    name + ':commit-container',
    [
      name + ':copy-bundle-files-to-srv',
    ],
    function(callback) {
      var dockerArgs = [];
      dockerArgs.push('commit');
      dockerArgs.push('--change="WORKDIR /srv"');
      dockerArgs.push('--change="CMD NODE_ENV=' + environment + ' node ' + config.package.main + '"');

      if (config.orchestration.services != null) {
        var containerPorts = [];
        for (var i = 0; i < config.orchestration.services.length; i++) {
          var value = config.orchestration.services[i][environment];
          containerPorts.push(value.containerPort);
        }

        if (containerPorts.length > 0) {
          dockerArgs.push('--change="EXPOSE ' + containerPorts.join(' ') + '"');
        }
      }

      dockerArgs.push(containerId);

      runProcessAndCapture(
        'docker',
        dockerArgs,
        (buffer, err) => {
          cleanupContainerThen(() => {
            if (err) {
              callback(err);
              return;
            }

            if (buffer.startsWith('sha256:')) {
              newImageId = buffer.substr(7, buffer.length - 7).trim();
            } else {
              newImageId = buffer.trim();
            }
            
            callback();
          });
        });
    }
  );

  declarer(
    name + ':tag-container',
    [
      name + ':commit-container',
    ],
    function(callback) {
      var version = config.dockerImageVersion || config.package.version;
      var dockerPrefix = config.cluster.environments[environment].dockerImagePrefix;
      runProcessWithOutput(
        'docker',
        [
          'tag',
          newImageId,
          dockerPrefix + config.package.name + ":" + version
        ],
        (err) => {
          if (err) {
            callback(err);
            return;
          }

          callback();
        });
    }
  );

  declarer(
    name,
    [
      name + ':tag-container'
    ],
    function(callback) {
      callback();
    }
  );
}

module.exports = declareBuildOptimizedTasks;