'use strict';

const { computeVersion, buildDate } = require('../../scripts/ci/version');
const { evaluateQuality, summariseTrend, parseProperties } = require('../../scripts/ci/quality-policy');
const { parseArgs, table, repoFromGitUrl, redact, registerSecret, xmlEscape } = require('../../scripts/ci/lib');

describe('build versioning', () => {
  test('uses major.minor from package.json and the Jenkins build number as patch', () => {
    expect(computeVersion('1.0.0', '42')).toBe('1.0.42');
    expect(computeVersion('2.3.9', '7')).toBe('2.3.7');
    expect(computeVersion('1.0.0', undefined)).toBe('1.0.0-local');
  });

  test('build dates are UTC ISO timestamps without milliseconds', () => {
    expect(buildDate(new Date('2026-09-25T01:02:03.456Z'))).toBe('2026-09-25T01:02:03Z');
  });
});

describe('custom quality policy', () => {
  const policy = {
    conditions: [
      { label: 'Coverage', metrics: ['coverage'], op: '>=', threshold: 85 },
      { label: 'Maintainability', metrics: ['software_quality_maintainability_rating', 'sqale_rating'], op: '<=', threshold: 1 },
      { label: 'Duplication', metrics: ['duplicated_lines_density'], op: '<=', threshold: 3 },
    ],
  };

  test('uses the first metric key SonarCloud returns and applies the comparison', () => {
    const result = evaluateQuality({ coverage: '91.5', sqale_rating: '1.0', duplicated_lines_density: '4.2' }, policy);
    expect(result.results.map((r) => [r.metric, r.status])).toEqual([
      ['coverage', 'pass'], ['sqale_rating', 'pass'], ['duplicated_lines_density', 'fail'],
    ]);
    expect(result.passed).toBe(false);
  });

  test('marks conditions without data as n/a instead of failing', () => {
    const result = evaluateQuality({ coverage: '90' }, policy);
    expect(result.results.filter((r) => r.status === 'n/a')).toHaveLength(2);
    expect(result.passed).toBe(true);
  });

  test('summarises metric history as a trend', () => {
    const trend = summariseTrend({ measures: [
      { metric: 'coverage', history: [{ value: '80.0' }, { value: '85.5' }, { value: '92.0' }] },
      { metric: 'ncloc', history: [{ value: '900' }] },
    ] });
    expect(trend[0]).toMatchObject({ metric: 'coverage', first: 80, last: 92, change: 12, analyses: 3 });
    expect(trend[1]).toMatchObject({ metric: 'ncloc', change: 0 });
    expect(summariseTrend(null)).toEqual([]);
  });

  test('parses sonar-project.properties style files', () => {
    expect(parseProperties('# comment\nsonar.projectKey=abc\r\nsonar.host.url = https://x=y\n\nnot a property')).toEqual({
      'sonar.projectKey': 'abc',
      'sonar.host.url': 'https://x=y',
    });
  });
});

describe('pipeline script helpers', () => {
  test('parses --key value, --key=value and flags', () => {
    expect(parseArgs(['trivy', '--image', 'a:1', '--env=staging', '--rollback'])).toEqual({ _: ['trivy'], image: 'a:1', env: 'staging', rollback: true });
  });

  test('formats aligned text tables', () => {
    expect(table(['Tool', 'High'], [['npm', 0], ['trivy', 12]])).toBe('Tool   High\n-----  ----\nnpm    0\ntrivy  12');
  });

  test('extracts owner/repo from GitHub URLs', () => {
    expect(repoFromGitUrl('https://github.com/phatthai/smishguard.git')).toBe('phatthai/smishguard');
    expect(repoFromGitUrl('git@github.com:phatthai/smishguard.git')).toBe('phatthai/smishguard');
    expect(repoFromGitUrl('https://gitlab.com/x/y')).toBeNull();
  });

  test('redacts registered secrets and secret environment variables from logs', () => {
    registerSecret('super-secret-value');
    process.env.GITHUB_TOKEN = 'ghp_exampletoken123';
    expect(redact('token=ghp_exampletoken123 pw=super-secret-value')).toBe('token=**** pw=****');
    delete process.env.GITHUB_TOKEN;
  });

  test('escapes XML for JUnit reports', () => {
    expect(xmlEscape('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;');
  });
});
