'use strict';

const http = require('node:http');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createMetrics } = require('./metrics');
const { openDatabase } = require('./db/database');
const { createApp, createMetricsServer } = require('./app');

const SHUTDOWN_TIMEOUT_MS = 10_000;

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}

/**
 * Starts the API and metrics servers. Returns a handle with stop() so tests and the
 * process signal handlers share one graceful-shutdown path.
 */
async function start(env = process.env) {
  const config = loadConfig(env);
  const logger = createLogger({ level: config.logLevel, env: config.env, version: config.build.version });
  const db = openDatabase(config.databasePath);
  const metrics = createMetrics({ version: config.build.version, commit: config.build.commit });
  const app = createApp({ config, logger, db, metrics });

  const server = await listen(http.createServer(app), config.port);
  const metricsServer = await listen(createMetricsServer(metrics.registry), config.metricsPort);
  logger.info(
    { port: server.address().port, metricsPort: metricsServer.address().port, env: config.env },
    'SmishGuard started',
  );

  let stopped = false;
  async function stop(signal = 'manual') {
    if (stopped) {
      return;
    }
    stopped = true;
    logger.info({ signal }, 'Shutting down gracefully');
    await Promise.all([close(server), close(metricsServer)]);
    db.close();
  }

  return { config, server, metricsServer, db, stop };
}

/* Process entry point: wire OS signals to graceful shutdown. */
if (require.main === module) {
  start()
    .then((instance) => {
      const shutdown = (signal) => {
        setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
        instance.stop(signal).then(() => process.exit(0), () => process.exit(1));
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    })
    .catch((err) => {
      process.stderr.write(`SmishGuard failed to start: ${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { start };
