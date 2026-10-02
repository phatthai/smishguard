# Alert runbook

Every SmishGuard alert links here. Each entry says what the alert means, how to confirm it and how to fix it. Useful links: Grafana http://localhost:3030/d/smishguard-overview, Prometheus http://localhost:9090/alerts, Alertmanager http://localhost:9093.

Common commands (replace `production` with `staging` where needed):

```bash
docker ps --filter name=smishguard                  # what is running
docker logs smishguard-production --tail 100        # recent logs (structured JSON)
curl http://localhost:3000/ready                    # readiness, including the database
curl http://localhost:3000/version                  # which build is live
```

**Roll back production** to the previous release (the pipeline does this automatically when a release fails):

```bash
# JWT_SECRET must be the production secret from the Jenkins credential jwt-secret-production
node scripts/ci/deploy.js --env production --image ghcr.io/phatthai/smishguard:<previous version>
```

**Silence an alert** during planned maintenance: Alertmanager UI > New Silence, or `amtool silence add alertname=<name> --duration=30m`.

## SmishGuardDown

Prometheus cannot scrape the instance's metrics endpoint: the container has stopped, crashed or is restarting.

- Check: `docker ps -a --filter name=smishguard-production` and the container logs. Look for a crash loop or an out-of-memory kill (`docker inspect smishguard-production --format '{{.State.OOMKilled}}'`).
- Fix: `docker start smishguard-production`. If a new release caused it, roll back. If it was killed for memory, see SmishGuardHighMemoryUsage.

## SmishGuardHealthCheckFailing

The external probe of `/health` fails although Prometheus may still reach the metrics port. The API is not serving users. (If the whole instance is down this alert is suppressed in favour of SmishGuardDown.)

- Check: `curl -v http://localhost:3000/health`, container logs, and whether the port mapping is intact (`docker port smishguard-production`).
- Fix: restart the container; roll back if it started after a release.

## SmishGuardDatabaseUnavailable

The readiness check cannot query SQLite. Requests that read or write reports will fail.

- Check: `curl http://localhost:3000/ready`; container logs for `SQLITE_` errors; free disk space on the Docker host; the `smishguard-production-data` volume.
- Fix: free disk space or restart the container. Do not delete the volume: it holds user data.

## SmishGuardHighErrorRate

More than 5% of requests return a 5xx error.

- Check: the "Error ratio" and "Request rate by route" panels to find the failing route; logs at level 50 (error) show stack traces.
- Fix: if it began with a release (see the deployment annotation on the dashboard), roll back first and investigate afterwards.

## SmishGuardHighLatency

95th percentile latency has been above 500 ms for 5 minutes.

- Check: "Latency percentiles", CPU and event loop lag panels. Login is expected to be slower because of password hashing; a surge of logins will raise latency.
- Fix: identify the slow route; if caused by abusive traffic, rate limits will contain it; otherwise scale resources (`CPU_LIMIT` in `deploy/production.env`).

## SmishGuardSuspiciousLoginActivity

More than 20 failed or blocked logins per minute, a sign of brute-force or credential-stuffing attacks.

- Check: "Logins per minute by result"; request logs for `/api/auth/login` and the client addresses involved.
- Fix: the login rate limiter already blocks each client after a few attempts. If the attack continues, block the source at the network edge and consider lowering `LOGIN_RATE_LIMIT_MAX`. Ask affected users to change their passwords if any login succeeded.

## SmishGuardScamCampaignSuspected

An unusual number of high-risk scam messages were checked or reported in 5 minutes. This is a product signal rather than a fault: a new scam campaign is probably circulating.

- Check: recent reports (`GET /api/reports` as an admin) and the "Scam checks by risk level" and "Checks by language" panels to see what the messages impersonate.
- Action: publish a community warning in the affected languages, and add any new look-alike domains or phrases to `src/services/riskRules.js`.

## SmishGuardHighMemoryUsage

Resident memory has stayed above 200 MiB for 5 minutes, close to the container limit.

- Check: the "Memory" panel for steady growth (a leak) versus a spike under load.
- Fix: restart to recover immediately; investigate a leak with heap snapshots in staging; raise `MEMORY_LIMIT` only if the growth is legitimate.

## SmishGuardEventLoopLag

The Node.js event loop is blocked (p99 lag above 200 ms), so every request is delayed.

- Check: CPU panel and which routes are busy; a burst of password hashing or very long messages can cause this.
- Fix: contain abusive traffic with rate limits; move CPU-heavy work off the request path if it recurs.
