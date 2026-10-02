'use strict';

/**
 * Security stage, final step: applies policies/security-policy.json to every scanner
 * report, prints a summary, writes reports/security/summary.{json,md} and fails the
 * pipeline if anything is blocking (or if a scanner produced no report).
 */
const path = require('node:path');
const { banner, info, table, readJson, writeFile, writeJson, main } = require('./lib');
const { fromNpmAudit, fromTrivy, fromSemgrep, evaluate } = require('./security-policy');

const DIR = 'reports/security';
const TOOL_LABELS = {
  'npm-audit': 'npm audit (SCA)',
  semgrep: 'Semgrep (SAST)',
  'trivy-fs': 'Trivy repo (deps, secrets, IaC)',
  'trivy-image': 'Trivy image (OS + libs)',
};

function load(file, parse) {
  const report = readJson(path.join(DIR, file));
  return report ? parse(report) : null;
}

function findingRows(findings, limit = 15) {
  return findings.slice(0, limit).map((f) => [f.severity, f.tool, f.id, f.target, f.title.slice(0, 70)]);
}

function toolRows(result) {
  return Object.entries(result.byTool).map(([tool, stats]) => [
    TOOL_LABELS[tool] || tool,
    stats.reportFound ? stats.bySeverity.critical : 'n/a',
    stats.reportFound ? stats.bySeverity.high : 'n/a',
    stats.reportFound ? stats.bySeverity.medium : 'n/a',
    stats.reportFound ? stats.bySeverity.low + stats.bySeverity.info + stats.bySeverity.unknown : 'n/a',
    stats.reportFound ? stats.blocking : 'MISSING',
  ]);
}

function printSection(title, findings, headers) {
  if (findings.length === 0) {
    return;
  }
  console.log(`\n${title} (${findings.length}):`);
  console.log(table(headers, findingRows(findings)));
}

function toMarkdown(result, policy) {
  const rows = toolRows(result).map((row) => `| ${row.join(' | ')} |`);
  const list = (items) => items.map((f) => `- **${f.severity}** \`${f.id}\` (${f.tool}) ${f.target}: ${f.title}. _${f.reason}_`);
  return [
    `## Security gate: ${result.passed ? 'PASSED' : 'FAILED'}`,
    '',
    `Policy: block ${policy.failOn.join(' and ')} findings and any leaked secret; unfixed vulnerabilities are tracked.`,
    '',
    '| Scanner | Critical | High | Medium | Low/Info | Blocking |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    ...(result.blocking.length ? ['### Blocking', ...list(result.blocking), ''] : []),
    ...(result.accepted.length ? ['### Accepted exceptions', ...list(result.accepted), ''] : []),
    ...(result.tracked.length ? ['### Tracked (no fix available yet)', ...list(result.tracked), ''] : []),
  ].join('\n');
}

main(() => {
  const policy = readJson('policies/security-policy.json');
  if (!policy) {
    throw new Error('policies/security-policy.json is missing or invalid');
  }
  banner('Security gate');
  const result = evaluate({
    'npm-audit': load('npm-audit.json', fromNpmAudit),
    semgrep: load('semgrep.json', fromSemgrep),
    'trivy-fs': load('trivy-fs.json', (report) => fromTrivy(report, 'trivy-fs')),
    'trivy-image': load('trivy-image.json', (report) => fromTrivy(report, 'trivy-image')),
  }, policy);

  console.log(table(['Scanner', 'Critical', 'High', 'Medium', 'Low/Info', 'Blocking'], toolRows(result)));
  const headers = ['Severity', 'Scanner', 'ID', 'Where', 'Title'];
  printSection('BLOCKING findings', result.blocking, headers);
  printSection('Accepted exceptions (documented, time-boxed)', result.accepted, headers);
  printSection('Tracked (no fix available yet)', result.tracked, headers);
  printSection('Informational (below threshold)', result.informational, headers);

  writeJson(`${DIR}/summary.json`, result);
  writeFile(`${DIR}/summary.md`, `${toMarkdown(result, policy)}\n`);

  if (result.missingReports.length > 0) {
    throw new Error(`Security gate failed closed: no report from ${result.missingReports.join(', ')}`);
  }
  if (!result.passed) {
    throw new Error(`Security gate failed: ${result.blocking.length} blocking finding(s)`);
  }
  info(`Security gate passed: ${result.total} findings reviewed, 0 blocking`);
});
