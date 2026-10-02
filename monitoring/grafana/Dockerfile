# Grafana with the Prometheus/Alertmanager data sources and the SmishGuard dashboard
# provisioned from files, so dashboards are version-controlled and reviewable.
FROM grafana/grafana:13.2.2

COPY provisioning/ /etc/grafana/provisioning/
COPY dashboards/ /etc/grafana/dashboards/

# 472 = the "grafana" user in the official image.
USER 472
