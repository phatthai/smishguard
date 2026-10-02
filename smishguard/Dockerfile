# syntax=docker/dockerfile:1

# SmishGuard container image: multi-stage, non-root, no package manager at runtime.
ARG NODE_IMAGE=node:24-alpine

# ---- Stage 1: install production dependencies only ------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

# ---- Stage 2: minimal runtime image ----------------------------------------------
FROM ${NODE_IMAGE} AS runtime

ARG APP_VERSION=0.0.0-dev
ARG GIT_COMMIT=unknown
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="smishguard" \
      org.opencontainers.image.description="Scam SMS (smishing) risk-check and reporting service" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.source="https://github.com/phatthai/smishguard" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    GIT_COMMIT=${GIT_COMMIT} \
    BUILD_DATE=${BUILD_DATE} \
    PORT=3000 \
    METRICS_PORT=9464 \
    DATABASE_PATH=/app/data/smishguard.db

WORKDIR /app

# Security hardening:
#  - apply the latest Alpine security patches on top of the base image
#  - remove npm, npx and corepack: not needed to run the app and a frequent source of CVEs
#  - create the data directory owned by the unprivileged "node" user
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && mkdir -p /app/data \
 && chown node:node /app/data

# Application files stay owned by root and read-only for the runtime user.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts/healthcheck.js ./scripts/healthcheck.js

# Run as the unprivileged "node" user (numeric id so orchestrators can verify non-root).
USER 1000:1000
EXPOSE 3000 9464

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "scripts/healthcheck.js"]

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
