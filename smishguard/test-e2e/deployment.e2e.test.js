'use strict';

/**
 * Post-deployment tests against a live environment (no app code is imported).
 *   BASE_URL          e.g. http://localhost:3001
 *   EXPECTED_VERSION  the version the pipeline has just deployed
 *   E2E_MODE          "full"  (staging: the whole user journey, creates test data)
 *                     "smoke" (production: read-only checks, no test data created)
 */
const crypto = require('node:crypto');

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const EXPECTED_VERSION = process.env.EXPECTED_VERSION;
const FULL_JOURNEY = (process.env.E2E_MODE || 'full') === 'full';

const SCAM = 'AusPost: your parcel is on hold. Pay the redelivery fee within 24 hours at https://auspost-redelivery.top/track';
const HARMLESS = 'Hey, are we still meeting for lunch on Friday?';

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function call(path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: parseJson(text), text };
}

describe(`deployed service at ${BASE_URL}`, () => {
  test('is live and ready', async () => {
    expect((await call('/health')).status).toBe(200);
    const ready = await call('/ready');
    expect(ready.status).toBe(200);
    expect(ready.json.checks.database).toBe('up');
  });

  test('runs the version the pipeline just deployed', async () => {
    const { json } = await call('/version');
    expect(json.service).toBe('smishguard');
    if (EXPECTED_VERSION) {
      expect(json.version).toBe(EXPECTED_VERSION);
    }
  });

  test('serves the web UI with security headers', async () => {
    const res = await call('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('SmishGuard');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  test('scores a known scam template as high risk', async () => {
    const res = await call('/api/check', { method: 'POST', body: { message: SCAM } });
    expect(res.status).toBe(200);
    expect(res.json.level).toBe('high');
  });

  test('scores a harmless message as low risk', async () => {
    const res = await call('/api/check', { method: 'POST', body: { message: HARMLESS } });
    expect(res.json.level).toBe('low');
  });

  test('rejects invalid input', async () => {
    const res = await call('/api/check', { method: 'POST', body: { message: '' } });
    expect(res.status).toBe(400);
  });

  test('public statistics are available', async () => {
    const res = await call('/api/stats');
    expect(res.status).toBe(200);
    expect(res.json.byLevel).toEqual(expect.objectContaining({ high: expect.any(Number) }));
  });
});

(FULL_JOURNEY ? describe : describe.skip)('user journey', () => {
  const email = `e2e.${crypto.randomUUID()}@example.test`;
  const password = `E2e-${crypto.randomUUID()}`;
  let token;
  let reportId;

  test('a new user can register and log in', async () => {
    expect((await call('/api/auth/register', { method: 'POST', body: { email, password } })).status).toBe(201);
    const login = await call('/api/auth/login', { method: 'POST', body: { email, password } });
    expect(login.status).toBe(200);
    token = login.json.token;
  });

  test('the user can report a scam and see it in their list', async () => {
    const created = await call('/api/reports', { method: 'POST', token, body: { message: SCAM, channel: 'sms' } });
    expect(created.status).toBe(201);
    expect(created.json.report.riskLevel).toBe('high');
    reportId = created.json.report.id;

    const list = await call('/api/reports', { token });
    expect(list.json.items.map((report) => report.id)).toContain(reportId);
  });

  test('the user can update and delete the report', async () => {
    const updated = await call(`/api/reports/${reportId}`, { method: 'PATCH', token, body: { status: 'confirmed_scam' } });
    expect(updated.json.report.status).toBe('confirmed_scam');
    expect((await call(`/api/reports/${reportId}`, { method: 'DELETE', token })).status).toBe(204);
    expect((await call(`/api/reports/${reportId}`, { token })).status).toBe(404);
  });

  test('protected routes reject anonymous requests', async () => {
    expect((await call('/api/reports')).status).toBe(401);
  });
});
