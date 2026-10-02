'use strict';

const crypto = require('node:crypto');
const request = require('supertest');
const { loadConfig } = require('../../src/config');
const { createLogger } = require('../../src/logger');
const { createMetrics } = require('../../src/metrics');
const { openDatabase } = require('../../src/db/database');
const { createApp } = require('../../src/app');

// Generated per test run so no credential is ever hard-coded in the repository.
const TEST_SECRET = crypto.randomBytes(32).toString('hex');
const TEST_PASSWORD = `Pw-${crypto.randomUUID()}`;

/** Builds the real application against a fresh in-memory database. */
function buildTestApp(env = {}) {
  const config = loadConfig({
    APP_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_PATH: ':memory:',
    JWT_SECRET: TEST_SECRET,
    ...env,
  });
  const logger = createLogger({ level: 'silent' });
  const db = openDatabase(config.databasePath);
  const metrics = createMetrics({ version: config.build.version, commit: config.build.commit, collectDefaults: false });
  const app = createApp({ config, logger, db, metrics });
  return { app, db, metrics, config };
}

const uniqueEmail = (prefix = 'user') => `${prefix}.${crypto.randomUUID()}@example.test`;

async function registerUser(app, { email = uniqueEmail(), password = TEST_PASSWORD } = {}) {
  const res = await request(app).post('/api/auth/register').send({ email, password });
  if (res.status !== 201) {
    throw new Error(`registration failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { token: res.body.token, user: res.body.user, email, password };
}

/** Reads a counter/gauge value from the app's Prometheus registry. */
async function metricValue(metrics, name, labels = {}) {
  const metric = await metrics.registry.getSingleMetric(name).get();
  const match = metric.values.find((v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val));
  return match ? match.value : 0;
}

module.exports = { buildTestApp, registerUser, uniqueEmail, metricValue, TEST_SECRET, TEST_PASSWORD };
