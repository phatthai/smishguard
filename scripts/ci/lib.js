'use strict';

/**
 * Shared helpers for the pipeline scripts in scripts/ci.
 *
 * The scripts are plain Node.js with no dependencies so the same Jenkinsfile runs on
 * Windows (bat) and Linux (sh) agents. Commands are spawned without a shell, which
 * passes arguments verbatim and avoids quoting and injection problems.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const IS_WINDOWS = process.platform === 'win32';
const SECRET_ENV_VARS = ['JWT_SECRET', 'GITHUB_TOKEN', 'SONAR_TOKEN', 'DISCORD_WEBHOOK_URL', 'GRAFANA_ADMIN_PASSWORD'];
const extraSecrets = new Set();

/** Registers a value (e.g. a generated password) that must never appear in logs. */
function registerSecret(value) {
  if (value) {
    extraSecrets.add(value);
  }
}

function redact(text) {
  let output = String(text);
  const secrets = [...SECRET_ENV_VARS.map((name) => process.env[name]), ...extraSecrets];
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      output = output.split(secret).join('****');
    }
  }
  return output;
}

const banner = (title) => console.log(`\n==== ${title} ${'='.repeat(Math.max(3, 74 - title.length))}`);
const info = (message) => console.log(`[ci] ${redact(message)}`);
const warn = (message) => console.log(`[ci] WARNING: ${redact(message)}`);

function quoteArg(arg) {
  return /[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg;
}

function spawnOptions({ capture = false, input, env } = {}, command = '') {
  const stdin = input === undefined ? 'inherit' : 'pipe';
  const stdout = capture ? 'pipe' : 'inherit';
  return {
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
    shell: IS_WINDOWS && ['npm', 'npx'].includes(command),
    maxBuffer: 256 * 1024 * 1024,
    stdio: [stdin, stdout, stdout],
  };
}

function toOutput(result) {
  return { status: result.status, stdout: String(result.stdout ?? '').trim(), stderr: String(result.stderr ?? '').trim() };
}

function commandFailed(command, args, output) {
  if (output.stderr) {
    console.error(redact(output.stderr));
  }
  return new Error(`"${[command, ...args.slice(0, 2)].join(' ')}" exited with code ${output.status}`);
}

/**
 * Runs a command and returns { status, stdout, stderr }. Throws on a non-zero exit
 * unless check is false. npm/npx are .cmd shims on Windows and need a shell there.
 */
function run(command, args = [], options = {}) {
  const { check = true, quiet = false } = options;
  if (!quiet) {
    console.log(`$ ${redact([command, ...args].map(quoteArg).join(' '))}`);
  }
  const spawnOpts = spawnOptions(options, command);
  // With shell: true, Node 24 warns (DEP0190) if arguments are passed separately, so they are
  // joined into one quoted command line. Only npm/npx on Windows take this path.
  const result = spawnOpts.shell
    ? spawnSync([command, ...args.map(quoteArg)].join(' '), spawnOpts)
    : spawnSync(command, args, spawnOpts);
  if (result.error) {
    throw new Error(`Could not run "${command}": ${result.error.message}`);
  }
  const output = toOutput(result);
  if (check && output.status !== 0) {
    throw commandFailed(command, args, output);
  }
  return output;
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** HTTP helper that never throws: network failures come back as status 0. */
async function http(url, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
  const allHeaders = { Accept: 'application/json', 'User-Agent': 'smishguard-ci', ...headers };
  if (body !== undefined) {
    allHeaders['Content-Type'] = 'application/json';
  }
  try {
    const res = await fetch(url, {
      method,
      headers: allHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, json: parseJson(text) };
  } catch (err) {
    return { ok: false, status: 0, text: err.message, json: null };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls probe() until it returns { ok: true }. The probe can return a detail string
 * that is shown if the wait times out, which makes failures easy to diagnose.
 */
async function waitFor(description, probe, { timeoutMs = 60000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = { ok: false, detail: 'not checked yet' };
  while (Date.now() < deadline) {
    last = await probe();
    if (last.ok) {
      return last;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${description} (last result: ${last.detail})`);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const writeJson = (file, data) => writeFile(file, `${JSON.stringify(data, null, 2)}\n`);

/** Parses "--key value", "--key=value" and "--flag" arguments. */
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split(/=(.*)/s);
    const next = argv[i + 1];
    if (inline !== undefined) {
      args[key] = inline;
    } else if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required`);
  }
  return value;
}

/** Formats rows as a fixed-width text table for readable Jenkins console output. */
function table(headers, rows) {
  const cells = [headers, ...rows].map((row) => row.map((cell) => String(cell ?? '')));
  const widths = headers.map((_, col) => Math.max(...cells.map((row) => row[col].length)));
  const line = (row) => row.map((cell, col) => cell.padEnd(widths[col])).join('  ').trimEnd();
  return [line(cells[0]), widths.map((w) => '-'.repeat(w)).join('  '), ...cells.slice(1).map(line)].join('\n');
}

function xmlEscape(value) {
  const entities = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };
  return String(value).replace(/[<>&'"]/g, (char) => entities[char]);
}

/** Writes a JUnit XML report so Jenkins shows scripted checks as test results. */
function writeJUnit(file, suiteName, cases) {
  const failures = cases.filter((testCase) => testCase.failure).length;
  const seconds = (ms) => ((ms || 0) / 1000).toFixed(3);
  const body = cases.map((testCase) => {
    const failure = testCase.failure ? `<failure message="${xmlEscape(testCase.failure)}"/>` : '';
    return `  <testcase classname="${xmlEscape(suiteName)}" name="${xmlEscape(testCase.name)}" time="${seconds(testCase.durationMs)}">${failure}</testcase>`;
  });
  const total = cases.reduce((sum, testCase) => sum + (testCase.durationMs || 0), 0);
  writeFile(file, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${xmlEscape(suiteName)}" tests="${cases.length}" failures="${failures}" time="${seconds(total)}">`,
    ...body,
    '</testsuite>',
    '',
  ].join('\n'));
}

/** "https://github.com/owner/repo.git" -> "owner/repo" */
function repoFromGitUrl(url = '') {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

const basicAuth = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

/** Creates the shared Docker network used by the app environments and the monitoring stack. */
function ensureNetwork(name = 'smishguard-observability') {
  if (run('docker', ['network', 'inspect', name], { check: false, capture: true, quiet: true }).status !== 0) {
    run('docker', ['network', 'create', name]);
  }
}

/** Runs a script's main function and turns any error into a clean non-zero exit. */
function main(fn) {
  Promise.resolve()
    .then(fn)
    .catch((err) => {
      console.error(`[ci] FAILED: ${redact(err.message)}`);
      process.exitCode = 1;
    });
}

module.exports = {
  IS_WINDOWS,
  registerSecret,
  redact,
  banner,
  info,
  warn,
  run,
  http,
  sleep,
  waitFor,
  parseJson,
  readJson,
  writeFile,
  writeJson,
  parseArgs,
  requireEnv,
  table,
  xmlEscape,
  writeJUnit,
  repoFromGitUrl,
  basicAuth,
  ensureNetwork,
  main,
};
