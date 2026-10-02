'use strict';

/**
 * Release stage: creates the Git tag v<version> and a GitHub Release for the commit
 * that was just promoted to production. Release notes are generated from the commit
 * log and from the pipeline's own evidence (tests, coverage, quality, security, deploys).
 * Needs GITHUB_TOKEN; the repository is taken from GIT_URL (set by Jenkins).
 */
const fs = require('node:fs');
const path = require('node:path');
const { banner, info, run, http, readJson, writeJson, requireEnv, repoFromGitUrl, main } = require('./lib');

function previousTag(commit) {
  const res = run('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*', `${commit}^`], { check: false, capture: true, quiet: true });
  return res.status === 0 ? res.stdout : null;
}

function changelog(commit, fromTag) {
  const range = fromTag ? [`${fromTag}..${commit}`] : ['-n', '15', commit];
  const res = run('git', ['log', '--no-merges', '--pretty=format:- %s (%h, %an)', ...range], { check: false, capture: true, quiet: true });
  return res.stdout || '- No commit messages found';
}

function junitTotals() {
  const dir = 'reports/junit';
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.endsWith('.xml')) : [];
  return files.map((file) => {
    const xml = fs.readFileSync(path.join(dir, file), 'utf8');
    const root = /<testsuites?\b[^>]*>/.exec(xml)?.[0] ?? '';
    const attrs = Object.fromEntries([...root.matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, Number(value) || 0]));
    return { file, tests: attrs.tests ?? 0, failures: (attrs.failures ?? 0) + (attrs.errors ?? 0) };
  });
}

const line = (label, data, describe) => `- ${label}: ${data ? describe(data) : 'n/a'}`;

function evidence() {
  const tests = junitTotals().map((t) => `- \`${t.file}\`: ${t.tests} tests, ${t.failures} failures`);
  return [
    '### Pipeline evidence',
    ...tests,
    line('Coverage', readJson('coverage/coverage-summary.json')?.total, (c) => `${c.lines.pct}% lines, ${c.branches.pct}% branches`),
    line('Code quality', readJson('reports/quality/summary.json'),
      (q) => `SonarCloud quality gate ${q.gateStatus}, custom policy ${q.policyPassed ? 'passed' : 'failed'}`),
    line('Security gate', readJson('reports/security/summary.json'),
      (s) => `${s.passed ? 'passed' : 'failed'} (${s.total} findings reviewed, ${s.blocking.length} blocking, ${s.accepted.length} accepted, ${s.tracked.length} tracked)`),
    line('Staging', readJson('reports/deploy-staging.json'), (d) => `${d.status} (previous: ${d.previousImage || 'none'})`),
    line('Production', readJson('reports/deploy-production.json'), (d) => `${d.status} (previous: ${d.previousImage || 'none'})`),
  ].join('\n');
}

function releaseNotes({ version, commit, image, fromTag }) {
  const registry = readJson('reports/registry.json', {});
  return [
    `## SmishGuard v${version}`,
    '',
    `Promoted to production by Jenkins build [#${process.env.BUILD_NUMBER}](${process.env.BUILD_URL || '#'}) from commit \`${commit.slice(0, 7)}\`.`,
    '',
    `### Changes since ${fromTag || 'the start of the project'}`,
    changelog(commit, fromTag),
    '',
    '### Artefact',
    `- Image: \`${image}\``,
    `- Digest: \`${registry.digest || 'n/a'}\``,
    `- Environment tag: \`${image.slice(0, image.lastIndexOf(':'))}:production\``,
    '',
    evidence(),
  ].join('\n');
}

main(async () => {
  const token = requireEnv('GITHUB_TOKEN');
  const version = requireEnv('APP_VERSION');
  const commit = requireEnv('GIT_COMMIT');
  const image = requireEnv('IMAGE');
  const repo = process.env.GITHUB_REPOSITORY || repoFromGitUrl(process.env.GIT_URL);
  if (!repo) {
    throw new Error('Cannot work out the GitHub repository (set GITHUB_REPOSITORY or GIT_URL)');
  }
  const tag = `v${version}`;
  const fromTag = previousTag(commit);
  banner(`GitHub Release ${tag} for ${repo}`);

  const res = await http(`https://api.github.com/repos/${repo}/releases`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: { tag_name: tag, target_commitish: commit, name: `SmishGuard ${tag}`, body: releaseNotes({ version, commit, image, fromTag }), make_latest: 'true' },
  });
  if (res.status === 422 && /already_exists/.test(res.text)) {
    info(`Release ${tag} already exists; nothing to do`);
    return;
  }
  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status}: ${res.text.slice(0, 300)}`);
  }
  writeJson('reports/release.json', { tag, url: res.json.html_url, commit, image, previousTag: fromTag });
  info(`Created tag ${tag} and release: ${res.json.html_url}`);
});
