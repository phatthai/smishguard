'use strict';

const { fromNpmAudit, fromTrivy, fromSemgrep, evaluate, normaliseSeverity } = require('../../scripts/ci/security-policy');

const POLICY = { failOn: ['critical', 'high'], failOnUnfixedVulnerabilities: false, exceptions: [] };
const NOW = new Date('2026-09-25T00:00:00Z');

const npmAudit = {
  vulnerabilities: {
    'path-to-regexp': {
      name: 'path-to-regexp',
      severity: 'high',
      range: '<0.1.12',
      fixAvailable: true,
      via: [{ source: 1101850, name: 'path-to-regexp', title: 'ReDoS in path-to-regexp', url: 'https://github.com/advisories/GHSA-rhx6-c78j-4q9w', severity: 'high', range: '<0.1.12' }],
    },
    express: { name: 'express', severity: 'high', range: '4.x', fixAvailable: true, via: ['path-to-regexp'] },
  },
};

const trivyImage = {
  Results: [
    {
      Target: 'smishguard (alpine 3.22)',
      Class: 'os-pkgs',
      Vulnerabilities: [
        { VulnerabilityID: 'CVE-2026-0001', PkgName: 'openssl', InstalledVersion: '3.5.0', FixedVersion: '3.5.1', Severity: 'HIGH', Title: 'openssl issue' },
        { VulnerabilityID: 'CVE-2026-0002', PkgName: 'busybox', InstalledVersion: '1.37', Severity: 'CRITICAL', Title: 'busybox issue (no fix)' },
        { VulnerabilityID: 'CVE-2026-0003', PkgName: 'zlib', InstalledVersion: '1.3', FixedVersion: '1.3.1', Severity: 'MEDIUM', Title: 'zlib issue' },
      ],
    },
  ],
};

const trivyRepo = {
  Results: [
    { Target: 'Dockerfile', Class: 'config', Misconfigurations: [
      { ID: 'DS002', Title: 'Image user should not be root', Severity: 'HIGH', Status: 'FAIL', Resolution: 'Add USER' },
      { ID: 'DS026', Title: 'No HEALTHCHECK', Severity: 'LOW', Status: 'PASS' },
    ] },
    { Target: 'src/config.js', Class: 'secret', Secrets: [{ RuleID: 'github-pat', Title: 'GitHub PAT', Severity: 'CRITICAL', StartLine: 12 }] },
  ],
};

const semgrep = {
  results: [
    { check_id: 'javascript.express.security.audit.express-check-csurf-middleware-usage', path: 'src/app.js', start: { line: 50 }, extra: { severity: 'WARNING', message: 'CSRF middleware not detected\nmore text' } },
    { check_id: 'javascript.lang.security.audit.code-injection', path: 'src/x.js', start: { line: 3 }, extra: { severity: 'ERROR', message: 'eval of user input' } },
  ],
  errors: [],
};

describe('security policy: scanner parsers', () => {
  test('npm audit: one finding per advisory, transitive references skipped', () => {
    const findings = fromNpmAudit(npmAudit);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ tool: 'npm-audit', id: 'GHSA-rhx6-c78j-4q9w', severity: 'high', fixAvailable: true });
  });

  test('Trivy: vulnerabilities, misconfigurations (failures only) and secrets', () => {
    const image = fromTrivy(trivyImage, 'trivy-image');
    expect(image.map((f) => f.id)).toEqual(['CVE-2026-0001', 'CVE-2026-0002', 'CVE-2026-0003']);
    expect(image[0]).toMatchObject({ category: 'os-package', fixAvailable: true, target: 'openssl@3.5.0 (fixed in 3.5.1)' });
    const repo = fromTrivy(trivyRepo, 'trivy-fs');
    expect(repo.map((f) => f.category)).toEqual(['misconfiguration', 'secret']);
  });

  test('Semgrep: maps ERROR to high and WARNING to medium', () => {
    const findings = fromSemgrep(semgrep);
    expect(findings.map((f) => f.severity)).toEqual(['medium', 'high']);
    expect(findings[0].title).toBe('CSRF middleware not detected');
  });

  test.each([['moderate', 'medium'], ['HIGH', 'high'], [undefined, 'unknown'], ['weird', 'unknown']])('normaliseSeverity(%p) = %s', (input, expected) => {
    expect(normaliseSeverity(input)).toBe(expected);
  });

  test('empty or missing reports produce no findings', () => {
    expect(fromNpmAudit({})).toEqual([]);
    expect(fromTrivy({}, 'trivy-fs')).toEqual([]);
    expect(fromSemgrep({})).toEqual([]);
  });
});

describe('security policy: gate decisions', () => {
  const reports = () => ({
    'npm-audit': fromNpmAudit(npmAudit),
    semgrep: fromSemgrep(semgrep),
    'trivy-fs': fromTrivy(trivyRepo, 'trivy-fs'),
    'trivy-image': fromTrivy(trivyImage, 'trivy-image'),
  });

  test('blocks high/critical findings with a fix, secrets and ERROR-level SAST findings', () => {
    const result = evaluate(reports(), POLICY, NOW);
    expect(result.passed).toBe(false);
    expect(result.blocking.map((f) => f.id).sort()).toEqual(['CVE-2026-0001', 'DS002', 'GHSA-rhx6-c78j-4q9w', 'github-pat', 'javascript.lang.security.audit.code-injection'].sort());
  });

  test('tracks vulnerabilities without a fix instead of blocking', () => {
    const result = evaluate(reports(), POLICY, NOW);
    expect(result.tracked.map((f) => f.id)).toEqual(['CVE-2026-0002']);
    expect(result.informational.map((f) => f.id)).toEqual(expect.arrayContaining(['CVE-2026-0003']));
  });

  test('a documented, unexpired exception accepts a finding; an expired one blocks again', () => {
    const exception = { id: 'CVE-2026-0001', tool: 'trivy-image', reason: 'Not reachable: TLS terminates at the proxy', expires: '2026-10-31' };
    const accepted = evaluate({ 'trivy-image': fromTrivy(trivyImage, 'trivy-image') }, { ...POLICY, exceptions: [exception] }, NOW);
    expect(accepted.accepted.map((f) => f.id)).toEqual(['CVE-2026-0001']);
    expect(accepted.passed).toBe(true);

    const later = new Date('2026-11-15T00:00:00Z');
    const expired = evaluate({ 'trivy-image': fromTrivy(trivyImage, 'trivy-image') }, { ...POLICY, exceptions: [exception] }, later);
    expect(expired.passed).toBe(false);
    expect(expired.blocking[0].reason).toMatch(/exception expired on 2026-10-31/);
  });

  test('fails closed when a scanner produced no report', () => {
    const result = evaluate({ 'npm-audit': [], semgrep: null }, POLICY, NOW);
    expect(result.passed).toBe(false);
    expect(result.missingReports).toEqual(['semgrep']);
    expect(result.byTool.semgrep.reportFound).toBe(false);
  });

  test('passes a clean set of reports', () => {
    const result = evaluate({ 'npm-audit': [], semgrep: [], 'trivy-fs': [], 'trivy-image': [] }, POLICY, NOW);
    expect(result).toMatchObject({ passed: true, total: 0, blocking: [] });
  });
});
