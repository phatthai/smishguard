'use strict';

/**
 * Artefact storage in GitHub Container Registry (ghcr.io).
 *   node scripts/ci/registry.js push    --image ghcr.io/<owner>/smishguard:1.0.42 --also sha-abc1234
 *   node scripts/ci/registry.js promote --image ghcr.io/<owner>/smishguard:1.0.42 --tag production
 * "push" stores the immutable, versioned build. "promote" moves an environment tag
 * (e.g. production) to that exact image digest without rebuilding: build once, promote many.
 * Needs GITHUB_USER and GITHUB_TOKEN (a PAT with write:packages).
 */
const { banner, info, run, sleep, parseArgs, requireEnv, readJson, writeJson, main } = require('./lib');

const REPORT = 'reports/registry.json';

const repositoryOf = (image) => image.slice(0, image.lastIndexOf(':'));
const registryOf = (image) => image.split('/')[0];

function login(image) {
  const registry = registryOf(image);
  run('docker', ['login', registry, '--username', requireEnv('GITHUB_USER'), '--password-stdin'], {
    input: requireEnv('GITHUB_TOKEN'),
    capture: true,
  });
  info(`Logged in to ${registry}`);
}

async function pushWithRetry(ref, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (run('docker', ['push', ref], { check: false }).status === 0) {
      return;
    }
    if (attempt < attempts) {
      info(`Push failed, retrying in ${attempt * 5}s (${attempt}/${attempts})`);
      await sleep(attempt * 5000);
    }
  }
  throw new Error(`Could not push ${ref} after ${attempts} attempts`);
}

function digestOf(image) {
  const digests = JSON.parse(run('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', image], { capture: true, quiet: true }).stdout || '[]');
  const match = digests.find((entry) => entry.startsWith(`${repositoryOf(image)}@`));
  return match ? match.slice(match.indexOf('@') + 1) : null;
}

async function push(image, extraTags) {
  banner(`Publish build artefact: ${image}`);
  login(image);
  try {
    await pushWithRetry(image);
    for (const tag of extraTags) {
      await pushWithRetry(`${repositoryOf(image)}:${tag}`);
    }
  } finally {
    run('docker', ['logout', registryOf(image)], { check: false, capture: true, quiet: true });
  }
  const digest = digestOf(image);
  writeJson(REPORT, { image, tags: [image.slice(image.lastIndexOf(':') + 1), ...extraTags], digest, pushedAt: new Date().toISOString() });
  info(`Stored ${image} (${digest})`);
}

async function promote(image, tag) {
  const target = `${repositoryOf(image)}:${tag}`;
  banner(`Promote ${image} -> ${target}`);
  run('docker', ['tag', image, target]);
  login(image);
  try {
    await pushWithRetry(target);
  } finally {
    run('docker', ['logout', registryOf(image)], { check: false, capture: true, quiet: true });
  }
  const record = readJson(REPORT, { image });
  writeJson(REPORT, { ...record, promotedTo: [...new Set([...(record.promotedTo ?? []), tag])], digest: digestOf(image) ?? record.digest });
  info(`${target} now points to ${digestOf(image)}`);
}

main(async () => {
  const args = parseArgs(process.argv.slice(2));
  const image = args.image || requireEnv('IMAGE');
  const extraTags = typeof args.also === 'string' ? args.also.split(',').filter(Boolean) : [];
  const commands = new Map([
    ['push', () => push(image, extraTags)],
    ['promote', () => promote(image, args.tag || requireEnv('PROMOTE_TAG'))],
  ]);
  const command = commands.get(args._[0]);
  if (!command) {
    throw new Error('Usage: registry.js push|promote --image <image> [--also tag1,tag2] [--tag production]');
  }
  await command();
});
