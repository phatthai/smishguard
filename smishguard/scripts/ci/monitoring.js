'use strict';

/**
 * Monitoring stage.
 *   node scripts/ci/monitoring.js up                          start or update the observability stack
 *   node scripts/ci/monitoring.js verify --expect-version X   prove production is scraped, alerting is
 *                                                             armed and no critical alert is firing
 *   node scripts/ci/monitoring.js annotate --text "..." --tags deploy,production
 * The stack is defined in monitoring/ and deployed like the app: configuration as code.
 */
const { banner, info, run, http, waitFor, table, parseArgs, requireEnv, writeJson, basicAuth, registerSecret, ensureNetwork, main } = require('./lib');

const PROMETHEUS = process.env.PROMETHEUS_URL || 'http://localhost:9090';
const ALERTMANAGER = process.env.ALERTMANAGER_URL || 'http://localhost:9093';
const GRAFANA = process.env.GRAFANA_URL || 'http://localhost:3030';
const DASHBOARD_UID = 'smishguard-overview';

const grafanaAuth = () => basicAuth('admin', requireEnv('GRAFANA_ADMIN_PASSWORD'));

function up() {
  banner('Start/update the observability stack: Prometheus, Alertmanager, Blackbox exporter, Grafana');
  requireEnv('DISCORD_WEBHOOK_URL');
  requireEnv('GRAFANA_ADMIN_PASSWORD');
  ensureNetwork();
  // --build rebuilds the Prometheus/Alertmanager/Grafana images, which re-runs promtool,
  // the alert-rule unit tests and amtool, so a broken rule or route fails here.
  run('docker', ['compose', '-p', 'smishguard-monitoring', '-f', 'monitoring/docker-compose.yml',
    'up', '-d', '--build', '--wait', '--wait-timeout', '180', '--remove-orphans']);
  info(`Prometheus ${PROMETHEUS} | Alertmanager ${ALERTMANAGER} | Grafana ${GRAFANA}`);
}

async function promQuery(expr) {
  const res = await http(`${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(expr)}`);
  return res.json?.data?.result ?? [];
}

const ready = (url) => async () => {
  const res = await http(url);
  return { ok: res.ok, detail: `HTTP ${res.status}` };
};

async function verifyTargets() {
  const { value: active } = await waitFor('production targets to be scraped successfully', async () => {
    const res = await http(`${PROMETHEUS}/api/v1/targets?state=active`);
    const targets = res.json?.data?.activeTargets ?? [];
    const production = targets.filter((t) => ['smishguard', 'blackbox-http'].includes(t.labels.job) && t.labels.env === 'production');
    const detail = production.map((t) => `${t.labels.job}=${t.health}`).join(', ') || 'no production targets yet';
    return { ok: production.length >= 2 && production.every((t) => t.health === 'up'), detail, value: targets };
  }, { timeoutMs: 120000, intervalMs: 5000 });
  const rows = active.filter((t) => t.labels.env)
    .map((t) => [t.labels.job, t.labels.env, t.labels.instance, t.health, t.lastScrapeDuration ? `${(t.lastScrapeDuration * 1000).toFixed(0)} ms` : '-']);
  console.log(table(['Job', 'Env', 'Target', 'Health', 'Scrape'], rows));
  return rows.length;
}

async function verifyVersion(expectedVersion) {
  await waitFor(`Prometheus to report v${expectedVersion} in production`, async () => {
    const version = (await promQuery('smishguard_build_info{env="production"}'))[0]?.metric?.version;
    return { ok: version === expectedVersion, detail: `seen ${version ?? 'nothing'}` };
  }, { timeoutMs: 90000, intervalMs: 5000 });
  info(`Prometheus confirms production is running v${expectedVersion}`);
}

async function verifyRules() {
  const res = await http(`${PROMETHEUS}/api/v1/rules?type=alert`);
  const rules = (res.json?.data?.groups ?? []).flatMap((group) => group.rules.map((rule) => [group.name, rule.name, rule.labels?.severity, rule.state]));
  if (rules.length === 0) {
    throw new Error('No alert rules are loaded in Prometheus');
  }
  console.log(table(['Group', 'Alert rule', 'Severity', 'State'], rules));
  return rules.length;
}

async function verifyAlertmanager() {
  await waitFor('Alertmanager to be ready', ready(`${ALERTMANAGER}/-/ready`), { timeoutMs: 60000 });
  const res = await http(`${ALERTMANAGER}/api/v2/alerts?active=true&silenced=false&inhibited=false`);
  const firing = (res.json ?? []).map((a) => [a.labels.alertname, a.labels.env, a.labels.severity, a.startsAt]);
  console.log(firing.length ? table(['Firing alert', 'Env', 'Severity', 'Since'], firing) : 'No alerts are currently firing.');
  const critical = firing.filter(([, env, severity]) => env === 'production' && severity === 'critical');
  if (critical.length > 0) {
    throw new Error(`Production has critical alerts firing after the release: ${critical.map(([name]) => name).join(', ')}`);
  }
  return firing.length;
}

async function verifyGrafana() {
  await waitFor('Grafana to be ready', async () => {
    const res = await http(`${GRAFANA}/api/health`);
    return { ok: res.ok && res.json?.database === 'ok', detail: `HTTP ${res.status}` };
  }, { timeoutMs: 120000, intervalMs: 3000 });
  const res = await http(`${GRAFANA}/api/dashboards/uid/${DASHBOARD_UID}`);
  if (!res.ok) {
    throw new Error(`The SmishGuard dashboard is not provisioned in Grafana (HTTP ${res.status})`);
  }
  info(`Dashboard ready: ${GRAFANA}/d/${DASHBOARD_UID}`);
}

async function sliSnapshot() {
  const value = async (expr, digits = 3) => {
    const result = (await promQuery(expr))[0]?.value?.[1];
    return result === undefined || result === 'NaN' ? 'n/a' : Number(result).toFixed(digits);
  };
  const sel = 'job="smishguard",env="production"';
  const snapshot = {
    requestsPerSecond: await value(`sum(rate(http_requests_total{${sel}}[5m]))`),
    errorRatio5xx: await value(`(sum(rate(http_requests_total{${sel},status_code=~"5.."}[5m])) or vector(0)) / sum(rate(http_requests_total{${sel}}[5m]))`, 4),
    latencyP95Seconds: await value(`histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{${sel}}[5m])))`),
    memoryMiB: await value(`process_resident_memory_bytes{${sel}} / 1048576`, 1),
    probeSeconds: await value('probe_duration_seconds{job="blackbox-http",env="production"}'),
  };
  console.log(table(['Production signal (live)', 'Value'], Object.entries(snapshot)));
  return snapshot;
}

async function verify(expectedVersion) {
  banner('Verify that production is monitored and healthy');
  await waitFor('Prometheus to be ready', ready(`${PROMETHEUS}/-/ready`), { timeoutMs: 90000 });
  const targets = await verifyTargets();
  await verifyVersion(expectedVersion);
  const rules = await verifyRules();
  const firing = await verifyAlertmanager();
  await verifyGrafana();
  const sli = await sliSnapshot();
  writeJson('reports/monitoring.json', { version: expectedVersion, targets, alertRules: rules, firingAlerts: firing, sli, checkedAt: new Date().toISOString() });
  info('Monitoring verified: targets up, version confirmed, alert rules armed, dashboards live');
}

function resetGrafanaPassword(password) {
  info('Grafana rejected the admin credentials (volume created with an older password); resetting it');
  registerSecret(password);
  run('docker', ['exec', 'smishguard-grafana', 'grafana', 'cli', 'admin', 'reset-admin-password', password], { capture: true });
}

async function annotate(text, tags) {
  const post = () => http(`${GRAFANA}/api/annotations`, { method: 'POST', headers: { Authorization: grafanaAuth() }, body: { time: Date.now(), tags, text } });
  let res = await post();
  if (res.status === 401) {
    resetGrafanaPassword(requireEnv('GRAFANA_ADMIN_PASSWORD'));
    res = await post();
  }
  if (!res.ok) {
    throw new Error(`Grafana annotation failed (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
  }
  info(`Release marked on Grafana dashboards: "${text}" [${tags.join(', ')}]`);
}

main(async () => {
  const args = parseArgs(process.argv.slice(2));
  const commands = new Map([
    ['up', () => up()],
    ['verify', () => verify(args['expect-version'] || requireEnv('APP_VERSION'))],
    ['annotate', () => annotate(args.text || `Release v${process.env.APP_VERSION}`, String(args.tags || 'deploy').split(','))],
  ]);
  const command = commands.get(args._[0]);
  if (!command) {
    throw new Error('Usage: monitoring.js up | verify --expect-version <v> | annotate --text <text> --tags a,b');
  }
  await command();
});
