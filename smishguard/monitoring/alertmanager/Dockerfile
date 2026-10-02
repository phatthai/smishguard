# Alertmanager with routing config and Discord message templates baked in.
# amtool validates the configuration during the build.
FROM prom/alertmanager:v0.34.1

COPY alertmanager.yml /etc/alertmanager/alertmanager.yml
COPY templates/ /etc/alertmanager/templates/

RUN ["amtool", "check-config", "/etc/alertmanager/alertmanager.yml"]

# 65534 = "nobody" in the Alertmanager base image.
USER 65534
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD ["wget", "-q", "-O", "/dev/null", "http://localhost:9093/-/ready"]
