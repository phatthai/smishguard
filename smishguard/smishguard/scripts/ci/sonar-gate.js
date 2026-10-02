'use strict';

/**
 * Code Quality stage, final step. Reads the results of the SonarCloud analysis through
 * its Web API and prints them in the Jenkins log:
 *   1. the SonarCloud quality gate ("Sonar way") and each of its conditions
 *   2. the custom policy in policies/quality-policy.json (thresholds as code)
 *   3. the trend of key metrics across recent analyses
 * Fails if the scanner failed, the SonarCloud gate failed, or the custom policy failed.
 *   node scripts/ci/sonar-gate.js --scanner-exit <exit code of the scanner>
 */
const fs = require('node:fs');
const { banner, info, warn, http, table, parseArgs, requireEnv, readJson, writeJson, main } = require('./lib');
const { evaluateQuality, summariseTrend, parseProperties } = require('./quality-policy');

async function sonarGet(host, token, path) {
  const res = await http(`${host}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return res;
}

/** Fetches measures in one call; if some metric keys do not exist on the server, falls back to one call per key. */
async function fetchMeasures(host, token, projectKey, keys) {
  const query = (metricKeys) => `/api/measures/component?component=${encodeURIComponent(projectKey)}&metricKeys=${metricKeys.join(',')}`;
  const toMap = (res) => Object.fromEntries((res.json?.component?.measures ?? []).map((m) => [m.metric, m.value ?? m.period?.value]));
  const batch = await sonarGet(host, token, query(keys));
  if (batch.ok) {
    return toMap(batch);
  }
  const single = await Promise.all(keys.map((key) => sonarGet(host, token, query([key]))));
  return Object.assign({}, ...single.filter((res) => res.ok).map(toMap));
}

async function printQualityGate(host, token, projectKey) {
  banner('SonarCloud quality gate (Sonar way, evaluated on new code)');
  const res = await sonarGet(host, token, `/api/qualitygates/project_status?projectKey=${encodeURIComponent(projectKey)}`);
  if (!res.ok) {
    throw new Error(`Could not read the quality gate (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
  }
  const { status, conditions = [] } = res.json.projectStatus;
  const rows = conditions.map((c) => [c.metricKey, c.comparator === 'LT' ? '>=' : '<=', c.errorThreshold, c.actualValue ?? '-', c.status]);
  console.log(rows.length ? table(['Metric', 'Must be', 'Threshold', 'Actual', 'Status'], rows) : '(no conditions evaluated: no new code in this analysis)');
  info(`Quality gate status: ${status}`);
  return status;
}

function printPolicy(evaluation) {
  banner('Custom quality policy (policies/quality-policy.json)');
  const rows = evaluation.results.map((r) => [r.label, r.metric, r.value ?? 'n/a', `${r.op} ${r.threshold}`, r.status.toUpperCase()]);
  console.log(table(['Condition', 'SonarCloud metric', 'Value', 'Required', 'Result'], rows));
  for (const skipped of evaluation.results.filter((r) => r.status === 'n/a')) {
    warn(`${skipped.label}: metric not reported by SonarCloud, condition skipped`);
  }
}

function printTrend(trend) {
  banner('Quality trend across recent analyses');
  const rows = trend.map((t) => [t.metric, t.series.join(' -> ') || '-', t.change > 0 ? `+${t.change}` : String(t.change)]);
  console.log(table(['Metric', 'Oldest -> latest', 'Change'], rows));
}

main(async () => {
  const args = parseArgs(process.argv.slice(2));
  const scannerExit = Number(args['scanner-exit'] ?? 0);
  const token = requireEnv('SONAR_TOKEN');
  const props = parseProperties(fs.readFileSync('sonar-project.properties', 'utf8'));
  const host = props['sonar.host.url'].replace(/\/$/, '');
  const projectKey = props['sonar.projectKey'];
  const policy = readJson('policies/quality-policy.json');

  const gateStatus = await printQualityGate(host, token, projectKey);
  const keys = [...new Set([...policy.conditions.flatMap((c) => c.metrics), ...policy.trendMetrics])];
  const evaluation = evaluateQuality(await fetchMeasures(host, token, projectKey, keys), policy);
  printPolicy(evaluation);

  const history = await sonarGet(host, token, `/api/measures/search_history?component=${encodeURIComponent(projectKey)}&metrics=${policy.trendMetrics.join(',')}&ps=100`);
  const trend = summariseTrend(history.json);
  printTrend(trend);
  info(`Dashboard: ${host}/project/overview?id=${encodeURIComponent(projectKey)}`);

  writeJson('reports/quality/summary.json', { gateStatus, policyPassed: evaluation.passed, conditions: evaluation.results, trend });
  if (scannerExit !== 0) {
    throw new Error(`SonarCloud scanner exited with code ${scannerExit} (analysis error or quality gate failure, see above)`);
  }
  if (gateStatus === 'ERROR') {
    throw new Error('SonarCloud quality gate failed');
  }
  if (!evaluation.passed) {
    throw new Error('Custom quality policy failed');
  }
  info('Code quality gates passed (ESLint, SonarCloud quality gate, custom policy)');
});
