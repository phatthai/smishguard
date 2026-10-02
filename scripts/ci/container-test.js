'use strict';

/**
 * Test stage, container smoke test: starts the freshly built image the way production
 * will run it and checks the artefact itself (health, version, non-root user, no npm,
 * size, labels). Results are written as JUnit XML so Jenkins shows them with the tests.
 *   node scripts/ci/container-test.js --image <image> --version <expected version>
 */
const crypto = require('node:crypto');
const { banner, info, run, http, waitFor, parseArgs, parseJson, requireEnv, writeJUnit, registerSecret, main } = require('./lib');

const MAX_IMAGE_MB = 250;

function inspect(target, format, kind = 'container') {
  return run('docker', [kind, 'inspect', '--format', format, target], { capture: true, quiet: true }).stdout;
}

/** Reads the host port Docker assigned to container port 3000 (JSON parsing works the same on Windows and Linux). */
function publishedPort(name) {
  const res = run('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', name], { check: false, capture: true, quiet: true });
  const bindings = parseJson(res.stdout)?.['3000/tcp'] ?? [];
  return bindings.map((binding) => binding.HostPort).find((port) => /^\d+$/.test(port ?? '')) ?? null;
}

async function waitForPort(name) {
  const { value } = await waitFor('Docker to publish port 3000', async () => {
    const port = publishedPort(name);
    return { ok: Boolean(port), detail: port ?? 'no host port yet', value: port };
  }, { timeoutMs: 30000, intervalMs: 1000 });
  return value;
}

function createChecker() {
  const results = [];
  async function check(name, fn) {
    const started = Date.now();
    try {
      const detail = await fn();
      results.push({ name, durationMs: Date.now() - started });
      info(`PASS  ${name}${detail ? ` (${detail})` : ''}`);
    } catch (err) {
      results.push({ name, durationMs: Date.now() - started, failure: err.message });
      info(`FAIL  ${name}: ${err.message}`);
    }
  }
  return { check, results };
}

async function getJson(url) {
  const res = await http(url);
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status}`);
  }
  return res.json;
}

async function runChecks({ check }, { name, image, expectedVersion }) {
  await check('container becomes healthy (Docker HEALTHCHECK)', () => waitFor('healthy container', async () => {
    const status = inspect(name, '{{.State.Health.Status}}');
    return { ok: status === 'healthy', detail: status };
  }, { timeoutMs: 90000 }).then(() => 'healthy'));
  const base = `http://127.0.0.1:${await waitForPort(name)}`;
  info(`Container API published at ${base}`);
  await check('GET /health returns 200', async () => (await getJson(`${base}/health`)).status);
  await check('GET /ready reports the database as up', async () => {
    const body = await getJson(`${base}/ready`);
    if (body.checks.database !== 'up') {
      throw new Error(`database is ${body.checks.database}`);
    }
    return 'database up';
  });
  await check(`GET /version reports ${expectedVersion}`, async () => {
    const body = await getJson(`${base}/version`);
    if (body.version !== expectedVersion) {
      throw new Error(`got ${body.version}`);
    }
    return `${body.version} (${body.commit.slice(0, 7)})`;
  });
  await check('runs as a non-root user', () => {
    const user = inspect(name, '{{.Config.User}}');
    if (!user || user === 'root' || user.split(':')[0] === '0') {
      throw new Error(`container user is "${user || 'root'}"`);
    }
    return `user ${user}`;
  });
  await check('npm is not shipped in the runtime image', () => {
    const found = run('docker', ['exec', name, 'sh', '-c', 'command -v npm || echo absent'], { capture: true, quiet: true }).stdout;
    if (found !== 'absent') {
      throw new Error(`npm found at ${found}`);
    }
    return 'npm absent';
  });
  await check(`image is smaller than ${MAX_IMAGE_MB} MB`, () => {
    const mb = Number(inspect(image, '{{.Size}}', 'image')) / 1e6;
    if (mb > MAX_IMAGE_MB) {
      throw new Error(`${mb.toFixed(1)} MB`);
    }
    return `${mb.toFixed(1)} MB`;
  });
  await check('OCI labels record the version', () => {
    const label = inspect(image, '{{index .Config.Labels "org.opencontainers.image.version"}}', 'image');
    if (label !== expectedVersion) {
      throw new Error(`label is "${label}"`);
    }
    return label;
  });
}

main(async () => {
  const args = parseArgs(process.argv.slice(2));
  const image = args.image || requireEnv('IMAGE');
  const expectedVersion = args.version || requireEnv('APP_VERSION');
  const name = `smishguard-ci-${process.env.BUILD_NUMBER || Date.now()}`;
  const secret = crypto.randomBytes(32).toString('hex');
  registerSecret(secret);

  banner(`Container smoke test: ${image}`);
  run('docker', ['rm', '-f', '-v', name], { check: false, capture: true, quiet: true });
  const checker = createChecker();
  try {
    run('docker', ['run', '-d', '--name', name, '-p', '127.0.0.1::3000', '-e', 'APP_ENV=production',
      '-e', `JWT_SECRET=${secret}`, '-e', 'LOG_LEVEL=warn', image], { capture: true });
    await runChecks(checker, { name, image, expectedVersion });
  } catch (err) {
    checker.results.push({ name: 'container starts', failure: err.message });
  } finally {
    if (checker.results.some((result) => result.failure)) {
      run('docker', ['logs', '--tail', '40', name], { check: false });
    }
    run('docker', ['rm', '-f', '-v', name], { check: false, capture: true, quiet: true });
    writeJUnit('reports/junit/container-smoke.xml', 'Container smoke test', checker.results);
  }
  const failed = checker.results.filter((result) => result.failure).length;
  if (failed > 0) {
    throw new Error(`${failed} container check(s) failed`);
  }
  info(`All ${checker.results.length} container checks passed`);
});
