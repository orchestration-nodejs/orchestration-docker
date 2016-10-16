module.exports = function getVersionlessPackageJson(callback) {
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