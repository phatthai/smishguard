# Security

## Application controls

| Threat | Control | Where |
|---|---|---|
| Stolen or guessed passwords | scrypt hashing (N=2^15, r=8, p=1) with a random salt per user; constant-time comparison | `src/services/passwords.js` |
| Account enumeration | Identical error for unknown email and wrong password, with a dummy hash check to equalise timing | `src/services/authService.js` |
| Brute force and credential stuffing | Strict login rate limit per client; failures counted and alerted on (`SmishGuardSuspiciousLoginActivity`) | `src/middleware/rateLimiters.js`, alert rules |
| Token forgery | Short-lived JWTs, algorithm pinned to HS256, issuer and audience checked, secret of at least 32 characters required in staging and production | `src/services/authService.js`, `src/config.js` |
| Broken access control | Every report route requires authentication; users only reach their own reports, and other users' reports return 404 so IDs cannot be probed | `src/services/reportService.js` |
| Injection | All SQL statements are static and parameterised; request bodies, queries and parameters are validated with zod | `src/repositories`, `src/routes` |
| Cross-site scripting | Strict Content-Security-Policy via helmet; the UI renders user data with `textContent` only | `src/app.js`, `public/app.js` |
| Oversized requests | 16 KB JSON limit and 2,000-character message limit | `src/app.js`, `src/services/riskEngine.js` |
| Information leakage | Generic 500 responses, `X-Powered-By` removed, credentials redacted from logs | `src/middleware/errorHandler.js`, `src/logger.js` |
| Container breakout and tampering | Non-root user, read-only root filesystem, all capabilities dropped, no privilege escalation, no npm in the image | `Dockerfile`, `deploy/docker-compose.yml` |
| Metrics exposure | Metrics are served on a separate port that is not published outside the Docker network | `src/app.js`, `deploy/docker-compose.yml` |
| Secret leakage | No secret in the repository: Jenkins credentials are bound per stage and redacted from logs; Alertmanager reads its webhook from a Docker secret | `Jenkinsfile`, `scripts/ci/lib.js`, `monitoring/` |

## Pipeline security scanning

| Tool | Scope | Blocking rule |
|---|---|---|
| npm audit | Production dependencies | critical or high with a fix available |
| Semgrep | Application code, pipeline scripts, Dockerfiles | ERROR-level findings |
| Trivy (repository) | Secrets, Dockerfile misconfigurations, dependencies | any secret; critical or high misconfiguration or vulnerability |
| Trivy (image) | OS packages and libraries in the built image | critical or high with a fix available |
| CycloneDX SBOM | Every component shipped in the image | not a gate; archived with each build |

The gate (`scripts/ci/security-gate.js`) applies [`policies/security-policy.json`](../policies/security-policy.json) and writes `reports/security/summary.md`, which is also included in the GitHub Release notes.

### Exceptions

A finding can be accepted only with a justification, an owner and an expiry date. After the expiry date it blocks the pipeline again, which forces a review:

```json
{
  "id": "CVE-2026-12345",
  "tool": "trivy-image",
  "reason": "Affects TLS client code that SmishGuard never calls; TLS terminates at the proxy.",
  "approvedBy": "Tien Phat Thai",
  "expires": "2026-12-31"
}
```

Vulnerabilities with no published fix are not blocking but are listed as "tracked" on every build, so they are patched as soon as a fix appears (the image build also runs `apk upgrade` and `--pull` to pick up OS patches).

## Pre-release review

Before the first pipeline run the code was scanned locally with Semgrep 1.178.0 (JavaScript, secrets and Dockerfile rules from the public semgrep-rules repository, a superset of the rulesets the pipeline uses) and Trivy 0.74.0 (secrets and Dockerfile misconfiguration checks).

| Finding | Severity | Assessment | Action |
|---|---|---|---|
| `unsafe-dynamic-method`: CLI scripts dispatched commands with `object[userInput]()` | Warning | Real weakness: an argument such as `constructor` could reach an unintended function | **Fixed**: dispatch now uses `Map` lookups |
| `detect-non-literal-regexp` in the release script | Warning | Low risk (fixed attribute names) but avoidable | **Fixed**: replaced with literal regular expressions |
| `express-check-csurf-middleware-usage` | Info | Not applicable: the API authenticates with a bearer token in the `Authorization` header, which browsers never attach automatically, and uses no cookies | Justified, no change |
| `jquery-insecure-method` in `public/app.js` | Warning | False positive: the code uses the DOM `append()` with nodes built through `textContent`, not jQuery HTML insertion | Justified, no change |
| `html-in-template-string` in the JUnit writer | Warning | False positive: it builds XML and every value passes through `xmlEscape()` | Justified, no change |
| `no-replaceall` | Warning | Only relevant to Node.js below 15; the project requires Node.js 22.13 or later (`engines`) | Justified, no change |
| `missing-image-version` on `FROM ${NODE_IMAGE}` | Warning | The build argument defaults to `node:24-alpine`; the scanner cannot resolve build arguments | Justified, no change |
| `dockerfile-source-not-pinned` | Info | Images are pinned by version tag, not digest | Accepted; digest pinning with automated updates is planned |
| `avoid-apk-upgrade` | Info | Deliberate: applies Alpine security patches released after the base image | Accepted trade-off (patch currency over byte-for-byte reproducibility) |
| Trivy DS-0026: no `HEALTHCHECK` in the Grafana image | Low | Not every Grafana image variant ships `wget` or `curl`; the Monitoring stage checks Grafana through `/api/health` instead | Accepted |
| Secrets | none found | | |

## Findings log

Update this table from `reports/security/summary.md` when a pipeline run reports something new.

| Date | Build | Scanner | Finding | Severity | Decision |
|---|---|---|---|---|---|
| | | | | | |
