'use strict';

/**
 * Security policy as code. Converts the output of every scanner into one common
 * finding format, then decides which findings block the pipeline.
 *
 * Decision order for each finding:
 *   1. matches a documented, unexpired exception  -> accepted  (justified, time-boxed)
 *   2. a leaked secret                            -> blocking  (always)
 *   3. severity is in policy.failOn               -> blocking, unless it is a
 *      vulnerability with no fix available yet    -> tracked   (re-checked every build)
 *   4. anything else                              -> informational
 * A scanner that produced no report is itself blocking: the gate fails closed.
 */

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info', 'unknown'];

const SEMGREP_SEVERITY = { CRITICAL: 'critical', ERROR: 'high', HIGH: 'high', WARNING: 'medium', MEDIUM: 'medium', INFO: 'low', LOW: 'low' };

function normaliseSeverity(value) {
  const severity = String(value || 'unknown').toLowerCase();
  if (severity === 'moderate') {
    return 'medium';
  }
  return SEVERITY_ORDER.includes(severity) ? severity : 'unknown';
}

function advisoryId(advisory) {
  const match = /GHSA-[\w-]+/.exec(advisory.url || '');
  return match ? match[0] : `npm-${advisory.source}`;
}

/** npm audit (v7+ JSON): one finding per advisory. */
function fromNpmAudit(report) {
  return Object.values(report?.vulnerabilities ?? {}).flatMap((vulnerability) => vulnerability.via
    .filter((via) => typeof via === 'object')
    .map((advisory) => ({
      tool: 'npm-audit',
      category: 'dependency',
      id: advisoryId(advisory),
      target: `${vulnerability.name}@${advisory.range || vulnerability.range}`,
      severity: normaliseSeverity(advisory.severity),
      title: advisory.title,
      fixAvailable: Boolean(vulnerability.fixAvailable),
    })));
}

function trivyVulnerabilities(result, tool) {
  return (result.Vulnerabilities ?? []).map((vuln) => ({
    tool,
    category: result.Class === 'os-pkgs' ? 'os-package' : 'dependency',
    id: vuln.VulnerabilityID,
    target: `${vuln.PkgName}@${vuln.InstalledVersion}${vuln.FixedVersion ? ` (fixed in ${vuln.FixedVersion})` : ''}`,
    severity: normaliseSeverity(vuln.Severity),
    title: vuln.Title || vuln.VulnerabilityID,
    fixAvailable: Boolean(vuln.FixedVersion),
  }));
}

function trivySecrets(result, tool) {
  return (result.Secrets ?? []).map((secret) => ({
    tool,
    category: 'secret',
    id: secret.RuleID,
    target: `${result.Target}:${secret.StartLine}`,
    severity: normaliseSeverity(secret.Severity),
    title: secret.Title,
    fixAvailable: null,
  }));
}

function trivyMisconfigurations(result, tool) {
  return (result.Misconfigurations ?? [])
    .filter((misconfig) => misconfig.Status !== 'PASS')
    .map((misconfig) => ({
      tool,
      category: 'misconfiguration',
      id: misconfig.ID || misconfig.AVDID,
      target: result.Target,
      severity: normaliseSeverity(misconfig.Severity),
      title: `${misconfig.Title}${misconfig.Resolution ? ` - ${misconfig.Resolution}` : ''}`,
      fixAvailable: null,
    }));
}

/** Trivy filesystem or image JSON (vulnerabilities, secrets and misconfigurations). */
function fromTrivy(report, tool) {
  return (report?.Results ?? []).flatMap((result) => [
    ...trivyVulnerabilities(result, tool),
    ...trivySecrets(result, tool),
    ...trivyMisconfigurations(result, tool),
  ]);
}

/** Semgrep JSON: static analysis (SAST) results. */
function fromSemgrep(report) {
  return (report?.results ?? []).map((result) => ({
    tool: 'semgrep',
    category: 'code',
    id: result.check_id,
    target: `${result.path}:${result.start?.line ?? '?'}`,
    severity: SEMGREP_SEVERITY[String(result.extra?.severity).toUpperCase()] ?? 'unknown',
    title: String(result.extra?.message ?? '').split('\n')[0].slice(0, 160),
    fixAvailable: null,
  }));
}

function findException(policy, finding, now) {
  const exception = (policy.exceptions ?? []).find((entry) => entry.id === finding.id && (!entry.tool || entry.tool === finding.tool));
  if (!exception) {
    return null;
  }
  return { ...exception, expired: new Date(`${exception.expires}T23:59:59Z`) < now };
}

function classify(finding, policy, now) {
  const exception = findException(policy, finding, now);
  if (exception && !exception.expired) {
    return { status: 'accepted', reason: `Exception until ${exception.expires}: ${exception.reason}` };
  }
  if (finding.category === 'secret') {
    return { status: 'blocking', reason: 'Secrets must never be committed or shipped' };
  }
  if (!policy.failOn.includes(finding.severity)) {
    return { status: 'informational', reason: 'Below the blocking severity threshold' };
  }
  const isVulnerability = finding.category === 'dependency' || finding.category === 'os-package';
  if (isVulnerability && !finding.fixAvailable && !policy.failOnUnfixedVulnerabilities) {
    return { status: 'tracked', reason: 'No fix published yet; re-checked on every build' };
  }
  const expiredNote = exception ? ` (exception expired on ${exception.expires})` : '';
  return { status: 'blocking', reason: `Severity ${finding.severity} is blocked by policy${expiredNote}` };
}

function countBySeverity(findings) {
  return Object.fromEntries(SEVERITY_ORDER.map((severity) => [severity, findings.filter((f) => f.severity === severity).length]));
}

/**
 * Evaluates all findings. `reports` maps a scanner name to its parsed findings, or to
 * null when the scanner did not produce a report.
 */
function evaluate(reports, policy, now = new Date()) {
  const missing = Object.entries(reports).filter(([, findings]) => findings === null).map(([tool]) => tool);
  const findings = Object.values(reports)
    .filter(Boolean)
    .flat()
    .map((finding) => ({ ...finding, ...classify(finding, policy, now) }));
  const byTool = Object.fromEntries(Object.entries(reports).map(([tool, toolFindings]) => {
    const evaluated = findings.filter((finding) => finding.tool === tool);
    return [tool, {
      reportFound: toolFindings !== null,
      total: evaluated.length,
      bySeverity: countBySeverity(evaluated),
      blocking: evaluated.filter((finding) => finding.status === 'blocking').length,
    }];
  }));
  const blocking = findings.filter((finding) => finding.status === 'blocking');
  return {
    passed: blocking.length === 0 && missing.length === 0,
    missingReports: missing,
    byTool,
    blocking,
    accepted: findings.filter((finding) => finding.status === 'accepted'),
    tracked: findings.filter((finding) => finding.status === 'tracked'),
    informational: findings.filter((finding) => finding.status === 'informational'),
    total: findings.length,
  };
}

module.exports = { fromNpmAudit, fromTrivy, fromSemgrep, evaluate, normaliseSeverity, SEVERITY_ORDER };
