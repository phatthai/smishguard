'use strict';

const express = require('express');
const { isDatabaseHealthy } = require('../db/database');

/**
 * Operational endpoints:
 *  - /health  liveness: the process is up (used by Docker HEALTHCHECK and blackbox probes)
 *  - /ready   readiness: dependencies (the database) are usable
 *  - /version build metadata, used by the pipeline to verify which build is deployed
 */
function healthRouter({ db, config }) {
  const router = express.Router();
  const startedAt = Date.now();

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
  });

  router.get('/ready', (_req, res) => {
    const databaseUp = isDatabaseHealthy(db);
    res.status(databaseUp ? 200 : 503).json({
      status: databaseUp ? 'ready' : 'not_ready',
      checks: { database: databaseUp ? 'up' : 'down' },
    });
  });

  router.get('/version', (_req, res) => {
    res.json({
      service: 'smishguard',
      version: config.build.version,
      commit: config.build.commit,
      buildDate: config.build.date,
      environment: config.env,
    });
  });

  return router;
}

module.exports = { healthRouter };
