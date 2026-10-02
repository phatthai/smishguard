'use strict';

const request = require('supertest');
const { buildTestApp } = require('../helpers/testApp');
const { createMetricsServer } = require('../../src/app');

describe('operational endpoints', () => {
  test('GET /health reports liveness', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });

  test('GET /ready reflects database availability', async () => {
    const { app, db } = buildTestApp();
    await request(app).get('/ready').expect(200, { status: 'ready', checks: { database: 'up' } });
    db.close();
    await request(app).get('/ready').expect(503, { status: 'not_ready', checks: { database: 'down' } });
  });

  test('GET /version exposes build metadata used by the pipeline', async () => {
    const { app } = buildTestApp({ APP_VERSION: '1.0.42', GIT_COMMIT: 'abc1234def', BUILD_DATE: '2026-09-25T00:00:00Z' });
    const res = await request(app).get('/version');
    expect(res.body).toEqual({
      service: 'smishguard',
      version: '1.0.42',
      commit: 'abc1234def',
      buildDate: '2026-09-25T00:00:00Z',
      environment: 'test',
    });
  });

  test('sends security headers and hides the framework', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test('serves the web UI', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('SmishGuard');
  });

  test('unknown routes return a JSON 404', async () => {
    const { app } = buildTestApp();
    await request(app).get('/api/nope').expect(404, { error: { code: 'NOT_FOUND', message: 'No route for GET /api/nope' } });
  });

  test('malformed and oversized JSON bodies are rejected cleanly', async () => {
    const { app } = buildTestApp();
    const malformed = await request(app).post('/api/check').set('Content-Type', 'application/json').send('{"message":');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('INVALID_JSON');
    const huge = await request(app).post('/api/check').send({ message: 'x'.repeat(20000) });
    expect(huge.status).toBe(413);
    expect(huge.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('unexpected errors return a generic 500 without internal details', async () => {
    const { app, db } = buildTestApp();
    db.close();
    const res = await request(app).get('/api/stats');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
  });
});

describe('metrics endpoint', () => {
  test('exposes RED, business and build metrics in Prometheus format', async () => {
    const { app, metrics } = buildTestApp({ APP_VERSION: '1.0.7', GIT_COMMIT: 'feedbee' });
    await request(app).get('/health');
    await request(app).post('/api/check').send({ message: 'URGENT: verify your account at bit.ly/x' });

    const res = await request(createMetricsServer(metrics.registry)).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('http_requests_total{method="GET",route="/health",status_code="200"');
    expect(res.text).toContain('http_request_duration_seconds_bucket');
    expect(res.text).toContain('smishguard_checks_total{risk_level="high",language="en",source="check"');
    expect(res.text).toContain('smishguard_build_info{version="1.0.7",commit="feedbee"');
    expect(res.text).toContain('smishguard_database_up{service="smishguard"} 1');
  });

  test('only serves GET /metrics', async () => {
    const { metrics } = buildTestApp();
    const server = createMetricsServer(metrics.registry);
    await request(server).get('/other').expect(404);
    await request(server).post('/metrics').expect(404);
  });

  test('returns 500 if metrics collection fails', async () => {
    const failing = { metrics: () => Promise.reject(new Error('boom')), contentType: 'text/plain' };
    await request(createMetricsServer(failing)).get('/metrics').expect(500);
  });
});
