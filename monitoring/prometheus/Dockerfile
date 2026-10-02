# Prometheus with SmishGuard config and alert rules baked in ("monitoring as code").
# The build itself is a quality gate: invalid config or failing alert-rule unit tests
# stop the image from being built, so a broken rule can never reach the running stack.
FROM prom/prometheus:v3.14.0

COPY prometheus.yml alert-rules.yml alert-rules.test.yml /etc/prometheus/

RUN promtool check config /etc/prometheus/prometheus.yml \
 && promtool test rules /etc/prometheus/alert-rules.test.yml

# 65534 = "nobody" in the Prometheus base image.
USER 65534
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD ["wget", "-q", "-O", "/dev/null", "http://localhost:9090/-/ready"]
