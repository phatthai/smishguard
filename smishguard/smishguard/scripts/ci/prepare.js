'use strict';

/**
 * Build stage, first step: clears reports from earlier builds (so nothing stale is
 * archived or evaluated) and records the toolchain versions used for this build.
 * Fails early with a clear message if Docker is not available.
 */
const fs = require('node:fs');
const { banner, run, table, main } = require('./lib');

function version(command, args) {
  try {
    const res = run(command, args, { check: false, capture: true, quiet: true });
    return res.status === 0 ? res.stdout.split('\n')[0] : null;
  } catch {
    return null;
  }
}

main(() => {
  for (const dir of ['reports', 'coverage', '.scannerwork']) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  banner('Build environment');
  const docker = version('docker', ['version', '--format', '{{.Server.Version}}']);
  const rows = [
    ['Node.js', process.version],
    ['npm', version('npm', ['--version']) ?? 'not found'],
    ['Git', version('git', ['--version']) ?? 'not found'],
    ['Docker Engine', docker ?? 'NOT AVAILABLE'],
    ['Docker Compose', version('docker', ['compose', 'version', '--short']) ?? 'not found'],
    ['Platform', `${process.platform} ${process.arch}`],
  ];
  console.log(table(['Tool', 'Version'], rows));
  if (!docker) {
    throw new Error('Docker is not reachable. Start Docker Desktop (and restart Jenkins if Docker was installed after it started).');
  }
});
