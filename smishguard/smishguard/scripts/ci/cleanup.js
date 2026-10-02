'use strict';

/**
 * Housekeeping after every build: removes leftover CI containers and old local images
 * of the app (keeping the newest few and anything a container still uses), so repeated
 * builds do not fill the disk. Never fails the build.
 *   node scripts/ci/cleanup.js --repo ghcr.io/<owner>/smishguard --keep 5
 */
const { banner, info, run, parseArgs, main } = require('./lib');

const quietly = { check: false, capture: true, quiet: true };

function removeCiContainers() {
  const names = run('docker', ['ps', '-a', '--filter', 'name=smishguard-ci-', '--format', '{{.Names}}'], quietly).stdout.split('\n').filter(Boolean);
  for (const name of names) {
    run('docker', ['rm', '-f', '-v', name], quietly);
  }
  return names.length;
}

const byVersionDesc = (a, b) => b.localeCompare(a, undefined, { numeric: true });

function pruneOldImages(repo, keep) {
  const tags = run('docker', ['images', repo, '--format', '{{.Tag}}'], quietly).stdout.split('\n')
    .filter((tag) => /^\d+\.\d+\.\d+$/.test(tag))
    .sort(byVersionDesc);
  const inUse = new Set(run('docker', ['ps', '-a', '--format', '{{.Image}}'], quietly).stdout.split('\n'));
  const removable = tags.slice(keep).filter((tag) => !inUse.has(`${repo}:${tag}`));
  for (const tag of removable) {
    run('docker', ['rmi', `${repo}:${tag}`], quietly);
  }
  return removable;
}

main(() => {
  const args = parseArgs(process.argv.slice(2));
  const keep = Number(args.keep || 5);
  banner('Cleanup');
  info(`Removed ${removeCiContainers()} leftover CI container(s)`);
  if (args.repo) {
    const removed = pruneOldImages(args.repo, keep);
    info(`Kept the newest ${keep} images of ${args.repo}; removed ${removed.length ? removed.join(', ') : 'none'}`);
  }
  run('docker', ['image', 'prune', '-f'], quietly);
  info('Pruned dangling images');
});
