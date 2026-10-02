'use strict';

const request = require('supertest');
const { buildTestApp, metricValue } = require('../helpers/testApp');

describe('POST /api/check', () => {
  test('scores a scam message as high risk with explanations', async () => {
    const { app, metrics } = buildTestApp();
    const res = await request(app)
      .post('/api/check')
      .send({ message: 'NAB: unusual activity. Your account is locked. Log in at https://nab-secure.top to verify your identity' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ level: 'high', language: 'en', linkCount: 1 });
    expect(res.body.signals.map((s) => s.id)).toEqual(expect.arrayContaining(['lookalike_domain', 'credential_request', 'urgency']));
    expect(await metricValue(metrics, 'smishguard_checks_total', { risk_level: 'high', source: 'check' })).toBe(1);
  });

  test('scores an everyday message as low risk', async () => {
    const { app } = buildTestApp();
    const res = await request(app).post('/api/check').send({ message: 'Are we still on for footy training at 5?' });
    expect(res.body).toMatchObject({ level: 'low', score: 0, signals: [] });
  });

  test.each([
    [{}, 'message'],
    [{ message: '   ' }, 'message'],
    [{ message: 'x'.repeat(2001) }, 'message'],
  ])('rejects invalid body %#', async (body, field) => {
    const { app } = buildTestApp();
    const res = await request(app).post('/api/check').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].field).toBe(field);
  });

  test('is rate limited per client', async () => {
    const { app } = buildTestApp({ CHECK_RATE_LIMIT_MAX: '2' });
    await request(app).post('/api/check').send({ message: 'hello' }).expect(200);
    await request(app).post('/api/check').send({ message: 'hello' }).expect(200);
    const limited = await request(app).post('/api/check').send({ message: 'hello' });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers).toHaveProperty('ratelimit-policy');
  });

  test('the general API limit applies to every /api route', async () => {
    const { app } = buildTestApp({ RATE_LIMIT_MAX: '1' });
    await request(app).get('/api/stats').expect(200);
    await request(app).get('/api/stats').expect(429);
  });
});
