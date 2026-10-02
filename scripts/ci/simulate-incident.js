'use strict';

/**
 * Incident simulation ("game day"). Proves end to end that monitoring detects a real
 * problem and that the team is alerted, then records a timeline (detection and recovery
 * times) in reports/incident-<scenario>.json.
 *   node scripts/ci/simulate-incident.js --scenario outage        crash production, wait for the page, recover
 *   node scripts/ci/simulate-incident.js --scenario login-attack  credential-stuffing against /api/auth/login
 *   node scripts/ci/simulate-incident.js --scenario scam-surge    a burst of scam texts hitting the checker
 * Optional: --env staging (default production).
 */
const crypto = require('node:crypto');
const { banner, info, run, http, sleep, waitFor, table, parseArgs, writeJson, main } = require('./lib');

const PROMETHEUS = process.env.PROMETHEUS_URL || 'http://localhost:9090';
const ALERTMANAGER = process.env.ALERTMANAGER_URL || 'http://localhost:9093';
const PORTS = { production: 3000, staging: 3001 };
const ALERT_TIMEOUT_MS = 5 * 60 * 1000;

const SCAM_TEMPLATES = [
  'AusPost: your parcel is on hold. Pay the $2.99 redelivery fee within 24 hours at https://auspost-redelivery.top/track',
  'Linkt: you have an unpaid toll. Pay now to avoid a fine: https://linkt-payments.top/pay',
  'myGov: you are eligible for a tax refund. Claim your refund at http://192.168.10.5/mygov',
  'Tài khoản Vietcombank của quý khách đã bị khóa. Vui lòng đăng nhập ngay lập tức tại vcb-xacminh.top để xác minh.',
  'NAB: unusual activity detected, your account is locked. Log in at https://nab-secure.top to verify your identity',
];

function createTimeline() {
  const started = Date.now();
  const events = [];
  return {
    started,
    mark(event) {
      const seconds = Math.round((Date.now() - started) / 1000);
      events.push({ seconds, event });
      info(`T+${seconds}s  ${event}`);
    },
    events,
  };
}

async function activeAlert(name, env) {
  const filters = [`alertname="${name}"`, `env="${env}"`].map((f) => `filter=${encodeURIComponent(f)}`).join('&');
  const res = await http(`${ALERTMANAGER}/api/v2/alerts?active=true&${filters}`);
  return (res.json ?? [])[0] ?? null;
}

async function waitForAlert(name, env) {
  const { value } = await waitFor(`${name} to fire`, async () => {
    const alert = await activeAlert(name, env);
    return { ok: Boolean(alert), detail: 'not firing yet', value: alert };
  }, { timeoutMs: ALERT_TIMEOUT_MS, intervalMs: 3000 });
  return value;
}

const receivers = (alert) => alert.receivers.map((receiver) => receiver.name).join(', ');

async function outage({ env, url, timeline }) {
  const container = `smishguard-${env}`;
  timeline.mark(`Simulated crash: stopping container ${container}`);
  run('docker', ['stop', container]);
  await waitFor('Prometheus to notice the outage', async () => {
    const res = await http(`${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(`up{job="smishguard",env="${env}"}`)}`);
    const value = res.json?.data?.result?.[0]?.value?.[1];
    return { ok: value === '0', detail: `up=${value}` };
  }, { timeoutMs: 60000, intervalMs: 2000 });
  timeline.mark('Detected: Prometheus scrape failed (up == 0), alert pending for 30s');
  const alert = await waitForAlert('SmishGuardDown', env);
  timeline.mark(`Alerted: SmishGuardDown FIRING (critical) -> notified via ${receivers(alert)}`);

  timeline.mark(`Recovery: restarting ${container}`);
  run('docker', ['start', container]);
  await waitFor('the service to be healthy again', async () => {
    const res = await http(`${url}/health`);
    return { ok: res.ok, detail: `HTTP ${res.status}` };
  }, { timeoutMs: 90000 });
  timeline.mark('Service healthy again');
  await waitFor('the alert to resolve', async () => ({ ok: !(await activeAlert('SmishGuardDown', env)), detail: 'still active' }),
    { timeoutMs: ALERT_TIMEOUT_MS, intervalMs: 5000 });
  timeline.mark('Resolved: alert cleared, RESOLVED notification sent');
}

/** Sends traffic until the alert fires, polling Alertmanager every few seconds. */
async function trafficUntilAlert({ alertName, env, timeline, intervalMs, send }) {
  const counts = {};
  const deadline = Date.now() + ALERT_TIMEOUT_MS;
  let lastPoll = Date.now();
  let alert = null;
  while (!alert && Date.now() < deadline) {
    const status = await send();
    counts[status] = (counts[status] || 0) + 1;
    if (Date.now() - lastPoll > 5000) {
      lastPoll = Date.now();
      alert = await activeAlert(alertName, env);
    }
    await sleep(intervalMs);
  }
  if (!alert) {
    throw new Error(`${alertName} did not fire within ${ALERT_TIMEOUT_MS / 60000} minutes`);
  }
  const summary = Object.entries(counts).map(([status, n]) => `HTTP ${status} x${n}`).join(', ');
  timeline.mark(`Alerted: ${alertName} FIRING -> notified via ${receivers(alert)} (traffic sent: ${summary})`);
  timeline.mark('Traffic stopped; the alert resolves by itself once the rate drops');
}

async function loginAttack({ env, url, timeline }) {
  timeline.mark('Credential-stuffing simulation: 3 login attempts per second with random accounts');
  await trafficUntilAlert({
    alertName: 'SmishGuardSuspiciousLoginActivity',
    env,
    timeline,
    intervalMs: 330,
    send: async () => (await http(`${url}/api/auth/login`, {
      method: 'POST',
      body: { email: `victim.${crypto.randomUUID()}@example.test`, password: `Guess-${crypto.randomUUID()}` },
    })).status,
  });
}

async function scamSurge({ env, url, timeline }) {
  timeline.mark('Scam campaign simulation: 40 high-risk scam texts per minute sent to /api/check');
  let i = 0;
  await trafficUntilAlert({
    alertName: 'SmishGuardScamCampaignSuspected',
    env,
    timeline,
    intervalMs: 1500,
    send: async () => {
      i += 1;
      return (await http(`${url}/api/check`, { method: 'POST', body: { message: SCAM_TEMPLATES[i % SCAM_TEMPLATES.length] } })).status;
    },
  });
}

const SCENARIOS = new Map([['outage', outage], ['login-attack', loginAttack], ['scam-surge', scamSurge]]);

main(async () => {
  const args = parseArgs(process.argv.slice(2));
  const scenario = args.scenario;
  const env = args.env || 'production';
  if (!SCENARIOS.has(scenario) || !Object.hasOwn(PORTS, env)) {
    throw new Error(`Usage: simulate-incident.js --scenario ${[...SCENARIOS.keys()].join('|')} [--env production|staging]`);
  }
  banner(`Incident simulation: ${scenario} on ${env}`);
  const timeline = createTimeline();
  await SCENARIOS.get(scenario)({ env, url: `http://localhost:${PORTS[env]}`, timeline });
  console.log(`\n${table(['Time', 'Event'], timeline.events.map((e) => [`T+${e.seconds}s`, e.event]))}`);
  writeJson(`reports/incident-${scenario}.json`, { scenario, env, startedAt: new Date(timeline.started).toISOString(), timeline: timeline.events });
  info('Incident simulation complete: the alert reached the team channel');
});
