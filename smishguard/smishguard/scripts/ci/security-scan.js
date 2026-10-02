'use strict';

/**
 * Security stage scanners. Each scanner writes a JSON report to reports/security and
 * does not fail the build on findings: the security gate (security-gate.js) applies the
 * policy afterwards, so every scanner always runs and every result is visible.
 *   node scripts/ci/security-scan.js npm-audit
 *   node scripts/ci/security-scan.js semgrep
 *   node scripts/ci/security-scan.js trivy --image <image>
 * Scanner output is read from stdout, so containers never write into the workspace.
 */
const fs = require('node:fs');
const { banner, info, run, parseArgs, parseJson, writeFile, requireEnv, main } = require('./lib');

const OUT = 'reports/security';
const TRIVY_IMAGE = 'aquasec/trivy:0.74.0';
const SEMGREP_IMAGE = 'semgrep/semgrep:1.178.0';
const TRIVY_CACHE = 'smishguard-trivy-cache:/root/.cache/trivy';
const DOCKER_SOCKET = '/var/run/docker.sock:/var/run/docker.sock';
const SEMGREP_RULESETS = ['p/javascript', 'p/nodejs', 'p/owasp-top-ten', 'p/jwt', 'p/secrets', 'p/dockerfile'];
const TRIVY_SKIP_DIRS = ['node_modules', 'coverage', 'reports', 'data', '.git', '.scannerwork'];

/** Saves scanner stdout as a report and fails closed if it is not valid JSON. */
function saveReport(file, label, output) {
  const data = parseJson(output.stdout);
  if (!data) {
    if (output.stderr) {
      console.error(output.stderr.split('\n').slice(-15).join('\n'));
    }
    throw new Error(`${label} did not produce a valid JSON report (exit code ${output.status})`);
  }
  writeFile(`${OUT}/${file}`, `${JSON.stringify(data, null, 2)}\n`);
  return data;
}

function npmAudit() {
  banner('SCA: npm audit on production dependencies (GitHub Advisory Database)');
  const prod = saveReport('npm-audit.json', 'npm audit', run('npm', ['audit', '--omit=dev', '--json'], { check: false, capture: true }));
  info(`Production dependencies: ${JSON.stringify(prod.metadata.vulnerabilities)}`);
  const all = saveReport('npm-audit-all.json', 'npm audit (all)', run('npm', ['audit', '--json'], { check: false, capture: true, quiet: true }));
  info(`Including dev dependencies (informational): ${JSON.stringify(all.metadata.vulnerabilities)}`);
}

function semgrep() {
  banner(`SAST: Semgrep (${SEMGREP_RULESETS.join(', ')})`);
  const args = ['run', '--rm', '-v', `${process.cwd()}:/src:ro`, '-w', '/src', SEMGREP_IMAGE, 'semgrep', 'scan',
    ...SEMGREP_RULESETS.flatMap((ruleset) => ['--config', ruleset]),
    '--metrics', 'off', '--disable-version-check', '--json', '--quiet', '.'];
  const report = saveReport('semgrep.json', 'Semgrep', run('docker', args, { check: false, capture: true }));
  info(`Semgrep: ${report.results.length} findings, ${report.paths?.scanned?.length ?? '?'} files scanned, ${report.errors.length} scan errors`);
}

function trivy(image) {
  const mount = ['-v', TRIVY_CACHE, '-v', `${process.cwd()}:/src:ro`];
  banner('Trivy filesystem: dependency CVEs, committed secrets, Dockerfile misconfigurations');
  const skip = TRIVY_SKIP_DIRS.flatMap((dir) => ['--skip-dirs', `/src/${dir}`]);
  const fsScan = run('docker', ['run', '--rm', ...mount, TRIVY_IMAGE, 'fs', '--scanners', 'vuln,secret,misconfig',
    '--format', 'json', '--quiet', ...skip, '/src'], { check: false, capture: true });
  saveReport('trivy-fs.json', 'Trivy filesystem scan', fsScan);

  banner(`Trivy image: OS and library CVEs in ${image}`);
  const imageArgs = ['run', '--rm', ...mount, '-v', DOCKER_SOCKET, TRIVY_IMAGE, 'image'];
  saveReport('trivy-image.json', 'Trivy image scan', run('docker', [...imageArgs, '--scanners', 'vuln,secret',
    '--format', 'json', '--quiet', image], { check: false, capture: true }));

  banner('SBOM: CycloneDX software bill of materials for the image');
  const sbom = saveReport('sbom.cdx.json', 'SBOM generation', run('docker', [...imageArgs, '--format', 'cyclonedx',
    '--quiet', image], { check: false, capture: true }));
  info(`SBOM lists ${sbom.components?.length ?? 0} components`);
}

main(() => {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(OUT, { recursive: true });
  const scanners = new Map([
    ['npm-audit', npmAudit],
    ['semgrep', semgrep],
    ['trivy', () => trivy(args.image || requireEnv('IMAGE'))],
  ]);
  const scanner = scanners.get(args._[0]);
  if (!scanner) {
    throw new Error(`Unknown scanner "${args._[0]}". Use one of: ${[...scanners.keys()].join(', ')}`);
  }
  scanner();
});
