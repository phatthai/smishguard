'use strict';

/**
 * Prints build metadata for the pipeline.
 *   node scripts/ci/version.js          -> 1.0.<BUILD_NUMBER>  (or 1.0.0-local outside Jenkins)
 *   node scripts/ci/version.js --date   -> build timestamp (UTC, ISO 8601)
 * Major and minor come from package.json; the patch number is the Jenkins build number,
 * so every build produces a unique, ordered, traceable version.
 */
const pkg = require('../../package.json');
const { parseArgs } = require('./lib');

function computeVersion(packageVersion, buildNumber) {
  const [major, minor] = packageVersion.split('.');
  return buildNumber ? `${major}.${minor}.${buildNumber}` : `${packageVersion}-local`;
}

function buildDate(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  console.log(args.date ? buildDate() : computeVersion(pkg.version, process.env.BUILD_NUMBER));
}

module.exports = { computeVersion, buildDate };
