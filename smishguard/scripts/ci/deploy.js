'use strict';

/**
 * Deploy and Release stages: deploys an image to an environment with Docker Compose,
 * verifies it, and rolls back automatically if verification fails.
 *   node scripts/ci/deploy.js --env staging --image <image>
 *   node scripts/ci/deploy.js --env production --image <image>
 *   node scripts/ci/deploy.js --env staging --rollback      (restore the previous image)
 * Needs JWT_SECRET for the target environment (injected by Jenkins).
 */
const fs = require('node:fs');
const { banner, info, warn, run, http, waitFor, parseArgs, readJson, writeJson, ensureNetwork, main } = require('./lib');

const COMPOSE_FILE = 'deploy/docker-compose.yml';

function environment(name) {
  if (!['staging', 'production'].includes(name)) {
    throw new Error(`Unknown environment "${name}" (use staging or production)`);
  }
  const envFile = `deploy/${name}.env`;
  const settings = Object.fromEntries(fs.readFileSync(envFile, 'utf8').split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith('#'))
    .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
  return {
    name,
    envFile,
    project: `smishguard-${name}`,
    container: `smishguard-${name}`,
    url: `http://localhost:${settings.HOST_PORT}`,
    report: `reports/deploy-${name}.json`,
  };
}

const versionOf = (image) => image.slice(image.lastIndexOf(':') + 1);

function runningImage(container) {
  const res = run('docker', ['inspect', '--format', '{{.Config.Image}}', container], { check: false, capture: true, quiet: true });
  return res.status === 0 ? res.stdout : null;
}

function composeUp(env, image) {
  const args = ['compose', '-p', env.project, '-f', COMPOSE_FILE, '--env-file', env.envFile,
    'up', '-d', '--wait', '--wait-timeout', '120', '--remove-orphans'];
  return run('docker', args, { check: false, env: { IMAGE: image } }).status === 0;
}

async function verify(env, expectedVersion) {
  await waitFor(`${env.url}/ready`, async () => {
    const res = await http(`${env.url}/ready`);
    return { ok: res.status === 200, detail: `HTTP ${res.status}` };
  }, { timeoutMs: 60000 });
  const version = await http(`${env.url}/version`);
  if (version.json?.version !== expectedVersion) {
    throw new Error(`${env.name} reports version ${version.json?.version}, expected ${expectedVersion}`);
  }
  info(`${env.name} is healthy and serving v${expectedVersion} at ${env.url}`);
}

async function deployAndVerify(env, image) {
  if (!composeUp(env, image)) {
    return false;
  }
  try {
    await verify(env, versionOf(image));
    return true;
  } catch (err) {
    warn(err.message);
    return false;
  }
}

async function rollback(env, previousImage, record) {
  if (!previousImage) {
    writeJson(env.report, { ...record, status: 'failed', note: 'No previous version to roll back to' });
    throw new Error(`Deployment to ${env.name} failed and there is no previous version to roll back to`);
  }
  warn(`Rolling back ${env.name} to ${previousImage}`);
  const restored = await deployAndVerify(env, previousImage);
  writeJson(env.report, { ...record, status: restored ? 'rolled_back' : 'rollback_failed', rolledBackTo: previousImage });
  if (!restored) {
    throw new Error(`Rollback of ${env.name} to ${previousImage} FAILED: manual intervention required`);
  }
  info(`Rollback complete: ${env.name} is serving ${previousImage} again`);
}

async function deploy(env, image) {
  banner(`Deploy ${image} to ${env.name}`);
  ensureNetwork();
  const previousImage = runningImage(env.container);
  info(previousImage ? `Currently running: ${previousImage}` : 'No previous deployment found (first deploy)');
  const started = Date.now();
  const record = { environment: env.name, image, version: versionOf(image), previousImage, url: env.url, startedAt: new Date(started).toISOString() };

  if (await deployAndVerify(env, image)) {
    writeJson(env.report, { ...record, status: 'deployed', durationSeconds: Math.round((Date.now() - started) / 1000) });
    info(`Deployed v${versionOf(image)} to ${env.name} in ${Math.round((Date.now() - started) / 1000)}s`);
    return;
  }
  run('docker', ['logs', '--tail', '40', env.container], { check: false });
  await rollback(env, previousImage === image ? null : previousImage, record);
  throw new Error(`Deployment of ${image} to ${env.name} failed verification and was rolled back`);
}

async function manualRollback(env) {
  banner(`Rollback ${env.name}`);
  const record = readJson(env.report);
  if (record?.status !== 'deployed') {
    info(`Nothing to roll back in ${env.name} (last deployment status: ${record?.status ?? 'none'})`);
    return;
  }
  if (!record.previousImage) {
    warn(`No previous image recorded for ${env.name}; nothing to roll back to`);
    return;
  }
  ensureNetwork();
  await rollback(env, record.previousImage, record);
}

main(async () => {
  const args = parseArgs(process.argv.slice(2));
  const env = environment(args.env);
  if (args.rollback) {
    await manualRollback(env);
    return;
  }
  if (!args.image) {
    throw new Error('--image is required');
  }
  await deploy(env, args.image);
});
