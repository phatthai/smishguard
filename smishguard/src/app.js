'use strict';

const http = require('node:http');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const pinoHttp = require('pino-http');

const { createUserRepository } = require('./repositories/userRepository');
const { createReportRepository } = require('./repositories/reportRepository');
const { createAuthService } = require('./services/authService');
const { createReportService } = require('./services/reportService');
const { authenticate } = require('./middleware/authenticate');
const { metricsMiddleware } = require('./middleware/metricsMiddleware');
const { createRateLimiters } = require('./middleware/rateLimiters');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const { registerDatabaseProbe } = require('./metrics');
const { isDatabaseHealthy } = require('./db/database');
const { healthRouter } = require('./routes/health');
const { authRouter } = require('./routes/auth');
const { checkRouter } = require('./routes/check');
const { reportsRouter } = require('./routes/reports');
const { statsRouter } = require('./routes/stats');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const QUIET_PATHS = new Set(['/health', '/ready']);

function requestLogger(logger) {
  return pinoHttp({
    logger,
    autoLogging: { ignore: (req) => QUIET_PATHS.has(req.url) },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) {
        return 'error';
      }
      return res.statusCode >= 400 ? 'warn' : 'info';
    },
  });
}

/**
 * Builds the Express application from its dependencies (composition root).
 * Dependencies are injected so tests can run the real app against an in-memory
 * database without starting a server.
 */
function createApp({ config, logger, db, metrics }) {
  const authService = createAuthService({ userRepository: createUserRepository(db), config, metrics });
  const reportService = createReportService({ reportRepository: createReportRepository(db), metrics });
  const limiters = createRateLimiters(config, metrics);
  const requireAuth = authenticate(authService);
  registerDatabaseProbe(metrics, () => isDatabaseHealthy(db));

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  // The app is served over plain HTTP inside each environment (TLS would terminate at a
  // reverse proxy in front of it), so the CSP must not force https:// for its own assets.
  app.use(helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } } }));
  app.use(requestLogger(logger));
  app.use(metricsMiddleware(metrics));
  app.use(express.json({ limit: '16kb' }));

  app.use(healthRouter({ db, config }));
  app.use('/api', limiters.api);
  app.use('/api/auth', authRouter({ authService, limiters, authenticate: requireAuth }));
  app.use('/api/check', checkRouter({ limiters, metrics }));
  app.use('/api/reports', reportsRouter({ reportService, authenticate: requireAuth }));
  app.use('/api/stats', statsRouter({ reportService }));
  app.use(express.static(PUBLIC_DIR, { maxAge: '1h' }));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}

/**
 * Metrics are served on a separate port that is only reachable inside the Docker
 * network, so Prometheus can scrape it without exposing /metrics publicly.
 */
function createMetricsServer(registry) {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    registry.metrics().then(
      (body) => res.writeHead(200, { 'Content-Type': registry.contentType }).end(body),
      () => res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Metrics unavailable'),
    );
  });
}

module.exports = { createApp, createMetricsServer };
