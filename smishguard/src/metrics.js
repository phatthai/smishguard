'use strict';

const client = require('prom-client');

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const SCORE_BUCKETS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

function httpMetrics(registers) {
  return {
    httpRequestDuration: new client.Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: LATENCY_BUCKETS,
      registers,
    }),
    httpRequestsTotal: new client.Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests handled',
      labelNames: ['method', 'route', 'status_code'],
      registers,
    }),
  };
}

function businessMetrics(registers) {
  return {
    checksTotal: new client.Counter({
      name: 'smishguard_checks_total',
      help: 'Messages risk-checked, by risk level, detected language and source',
      labelNames: ['risk_level', 'language', 'source'],
      registers,
    }),
    riskScore: new client.Histogram({
      name: 'smishguard_risk_score',
      help: 'Distribution of computed risk scores (0-100)',
      buckets: SCORE_BUCKETS,
      registers,
    }),
    reportsCreatedTotal: new client.Counter({
      name: 'smishguard_reports_created_total',
      help: 'Scam reports submitted by users',
      labelNames: ['risk_level'],
      registers,
    }),
    loginsTotal: new client.Counter({
      name: 'smishguard_auth_logins_total',
      help: 'Login attempts by result (success, failure, rate_limited)',
      labelNames: ['result'],
      registers,
    }),
    registrationsTotal: new client.Counter({
      name: 'smishguard_auth_registrations_total',
      help: 'New user registrations',
      registers,
    }),
  };
}

/**
 * Creates an isolated Prometheus registry with HTTP (RED), business and runtime
 * metrics. Each app instance gets its own registry so tests never share state.
 */
function createMetrics({ version = 'dev', commit = 'unknown', collectDefaults = true } = {}) {
  const registry = new client.Registry();
  registry.setDefaultLabels({ service: 'smishguard' });
  if (collectDefaults) {
    client.collectDefaultMetrics({ register: registry });
  }
  const registers = [registry];
  const buildInfo = new client.Gauge({
    name: 'smishguard_build_info',
    help: 'Always 1; labels identify the running build',
    labelNames: ['version', 'commit'],
    registers,
  });
  buildInfo.set({ version, commit }, 1);
  return { registry, buildInfo, ...httpMetrics(registers), ...businessMetrics(registers) };
}

/** Registers a gauge that reports database health on every scrape. */
function registerDatabaseProbe(metrics, probe) {
  return new client.Gauge({
    name: 'smishguard_database_up',
    help: '1 when the database answers a health query, otherwise 0',
    registers: [metrics.registry],
    collect() {
      this.set(probe() ? 1 : 0);
    },
  });
}

module.exports = { createMetrics, registerDatabaseProbe };
