# Pipeline design

This document explains how each stage of the SmishGuard pipeline works and why it was designed that way. The pipeline itself is in the [`Jenkinsfile`](../Jenkinsfile); the steps it calls are small, dependency-free Node.js scripts in [`scripts/ci`](../scripts/ci).

## Principles

1. **Build once, promote many.** One image is built per commit and the same image (same digest) moves from the container test to staging to production. Environments differ only in configuration and secrets, so what was tested is exactly what is released.
2. **Every stage is a gate.** Each stage has an explicit pass/fail rule. A failure stops the pipeline before anything reaches production, and a failed deployment or release rolls back automatically.
3. **Policy as code.** Thresholds live in versioned files and are reviewed like code: coverage thresholds in `jest.config.js`, lint limits in `eslint.config.js`, `policies/quality-policy.json`, `policies/security-policy.json`, and the alert rules with their unit tests.
4. **Evidence for every decision.** Tests, coverage, lint, quality, security, SBOM, deployment, release and monitoring results are written to `reports/` and archived with each build. Scripted checks are published as JUnit results so Jenkins shows them next to the tests.
5. **Portable.** The Jenkinsfile never uses shell-specific syntax. Scripts spawn commands without a shell (arguments are passed verbatim), so the same pipeline runs on a Windows agent (`bat`) or a Linux agent (`sh`).
6. **Least privilege for secrets.** Each stage binds only the credentials it needs, and every script redacts secret values from its output.

## Stage by stage

### 1. Build

- `prepare.js` clears reports from earlier builds and prints the toolchain versions, failing early with a clear message if Docker is unavailable.
- Version `1.0.<BUILD_NUMBER>`: major and minor come from `package.json`, the patch is the Jenkins build number, so every build has a unique, ordered version that points back to the build that produced it. The image is also tagged `sha-<commit>` so it points back to the exact source.
- `npm ci` installs exactly what `package-lock.json` specifies.
- `docker build --pull` always starts from the latest patched base image. The multi-stage Dockerfile installs only production dependencies, removes npm from the runtime image, runs as a non-root user, defines a health check, and records version, revision and build date as OCI labels.
- The image is pushed to GitHub Container Registry (artefact storage) and its digest is recorded in `reports/registry.json`, which Jenkins fingerprints.

### 2. Test

Two branches run in parallel:

- **Unit and integration tests** (Jest + Supertest). The real application is assembled with an in-memory SQLite database through dependency injection, so integration tests exercise real SQL, middleware, validation, authentication and error handling without mocks. Coverage thresholds (90% lines, 80% branches) make the stage fail if coverage drops. Results are published as JUnit (test trend) and Cobertura (coverage trend).
- **Container smoke test.** Starts the built image the way production runs it and checks the artefact itself: it becomes healthy, `/health`, `/ready` and `/version` answer correctly, it runs as non-root, npm is absent, the image is under 250 MB and its labels carry the version. This catches Dockerfile mistakes that code tests cannot see.

End-to-end tests run later against the deployed environments (see Deploy and Release), which completes the test pyramid.

### 3. Code Quality

Code quality is about how maintainable the code is for developers; security has its own stage.

- **ESLint** with explicit thresholds: cyclomatic complexity at most 10, nesting depth 3, 4 parameters, 60 lines per function, 300 lines per file, and zero warnings allowed. Results are also exported to SonarCloud.
- **SonarCloud** analyses the application with coverage and ESLint results imported. Exclusions are deliberate: the browser client is covered by end-to-end tests rather than unit tests, and pipeline scripts are linted but not part of the shipped application. The scanner waits for the quality gate ("Sonar way", evaluated on new code).
- **Custom policy and trend.** SonarCloud's free plan cannot host custom quality gates, so `sonar-gate.js` enforces `policies/quality-policy.json` through the SonarCloud Web API (overall coverage, duplication, maintainability, reliability and security ratings, issue counts) and prints how key metrics changed across recent analyses. It supports both the classic and the newer Multi-Quality Rule metric keys.

### 4. Security

Security is about protecting the application and its users. Three scanners run in parallel, then one gate decides:

| Scanner | Finds |
|---|---|
| npm audit | Known vulnerabilities in production dependencies (GitHub Advisory Database) |
| Semgrep | Insecure code patterns (JavaScript, Node.js, OWASP Top 10, JWT, secrets and Dockerfile rules) |
| Trivy (repository) | Committed secrets, Dockerfile misconfigurations, dependency vulnerabilities (a second advisory source) |
| Trivy (image) | OS and library vulnerabilities in the built image, plus a CycloneDX SBOM |

`security-gate.js` normalises every report and applies `policies/security-policy.json`: critical or high findings with a fix available block the pipeline, any leaked secret blocks it, vulnerabilities with no published fix are tracked and re-checked on every build, and documented exceptions are accepted only until their expiry date. If a scanner produced no report the gate fails closed. See [SECURITY.md](SECURITY.md).

### 5. Deploy (staging)

- `deploy/docker-compose.yml` defines the environment as code. `deploy/staging.env` holds non-secret settings; the JWT secret comes from Jenkins.
- Containers are hardened: read-only root filesystem, all Linux capabilities dropped, no privilege escalation, CPU and memory limits, log rotation. Only the API port is published.
- `deploy.js` records what was running, deploys with `docker compose up --wait`, then verifies readiness and that `/version` reports exactly the new build. If verification fails it redeploys the previous image automatically.
- The full end-to-end suite then runs against staging (register, log in, report, list, update, delete, anonymous access denied). If it fails, the stage's failure handler rolls staging back.

### 6. Release (production)

- The same image is deployed to production with `deploy/production.env` (stricter rate limits, less verbose logging, larger resource limits) and its own secret.
- A read-only smoke subset of the e2e suite runs, so no test data is created in production.
- The image is promoted by moving the `:production` tag in GHCR to its digest (no rebuild).
- `github-release.js` creates the Git tag `v<version>` and a GitHub Release whose notes list the commits since the previous release and the evidence from this build (tests, coverage, quality gate, security gate, deployments, image digest).
- A release is atomic: if any step fails, production is rolled back to the previous release.

### 7. Monitoring

- The monitoring stack is also code. Prometheus, Alertmanager and Grafana images are built from `monitoring/` with their configuration baked in, and building them re-runs `promtool check config`, the alert-rule unit tests and `amtool check-config`, so a broken rule or route cannot be deployed.
- `monitoring.js verify` waits until Prometheus scrapes production and the blackbox probe succeeds, confirms Prometheus reports the version that was just released, lists the loaded alert rules, checks that no critical production alert is firing, and confirms the Grafana dashboard is provisioned. It then prints a live snapshot of request rate, error ratio, p95 latency, memory and probe time.
- The release is marked on the Grafana dashboards as an annotation, so a change in behaviour can be linked to the deployment that caused it.
- Optional incident drills (outage, login attack, scam surge) prove detection and notification end to end and record a timeline.

Metrics cover four layers: RED metrics per route (rate, errors, duration), business signals (checks by risk level and language, reports), security signals (login results), and runtime health (CPU, memory, event loop lag, database). Alerts use `for` durations to avoid noise, severities for routing, inhibition to avoid double pages, and runbook links in every notification.

## Trade-offs and limitations

- **One Docker host.** Staging and production run on the same machine, which is fine for this project but not real isolation. The same Compose files could target separate hosts through Docker contexts, or be translated to Kubernetes manifests, without changing the pipeline logic.
- **Polling instead of webhooks.** Jenkins runs locally where GitHub cannot reach it, so it polls every two minutes. A publicly reachable Jenkins would use GitHub webhooks for instant builds.
- **SQLite.** Ideal for a single instance and zero-dependency tests. Running several replicas would need a server database such as PostgreSQL; the repository layer isolates that change.
- **Rule-based detection.** Explainable and fully testable, but scammers can learn to avoid keywords. A natural next step is a machine-learning classifier trained on community reports, keeping the rules as explainable features.
- **No manual approval gate.** Promotion to production is controlled by automated gates (tests, quality, security, staging verification) rather than a person clicking "proceed", which is continuous deployment. In a regulated setting an `input` approval step would be added before Release.
- **Base images are pinned by tag, not digest.** Tags keep the images readable and patchable; pinning by digest with automated update pull requests (Renovate or Dependabot) would make builds fully reproducible.
