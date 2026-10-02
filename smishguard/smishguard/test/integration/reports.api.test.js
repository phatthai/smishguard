'use strict';

const request = require('supertest');
const { buildTestApp, registerUser, metricValue } = require('../helpers/testApp');

const SCAM = 'Linkt: you have an unpaid toll. Pay now to avoid a fine: https://linkt-payments.top/pay';
const SAFE = 'Reminder: dentist appointment tomorrow at 10am.';

const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function createReport(app, token, body = { message: SCAM }) {
  const res = await request(app).post('/api/reports').set(auth(token)).send(body);
  expect(res.status).toBe(201);
  return res.body.report;
}

describe('scam reports API', () => {
  let ctx;
  let alice;
  let bob;

  beforeEach(async () => {
    ctx = buildTestApp({ ADMIN_EMAILS: 'admin@example.test' });
    [alice, bob] = await Promise.all([registerUser(ctx.app), registerUser(ctx.app)]);
  });

  test('requires authentication', async () => {
    await request(ctx.app).get('/api/reports').expect(401);
    await request(ctx.app).post('/api/reports').send({ message: SCAM }).expect(401);
  });

  test('creates a report with an automatic risk assessment', async () => {
    const res = await request(ctx.app).post('/api/reports').set(auth(alice.token))
      .send({ message: SCAM, channel: 'sms', sender: '+61 400 000 000', notes: 'Got this twice' });
    expect(res.status).toBe(201);
    expect(res.body.report).toMatchObject({ userId: alice.user.id, riskLevel: 'high', status: 'open', channel: 'sms' });
    expect(res.body.report.signals).toEqual(expect.arrayContaining(['lookalike_domain', 'payment_request']));
    expect(res.body.assessment.advice).toMatch(/Very likely a scam/);
    expect(await metricValue(ctx.metrics, 'smishguard_reports_created_total', { risk_level: 'high' })).toBe(1);
  });

  test.each([
    [{}],
    [{ message: SCAM, channel: 'pigeon' }],
    [{ message: SCAM, notes: 'x'.repeat(501) }],
  ])('validates the report body %#', async (body) => {
    await request(ctx.app).post('/api/reports').set(auth(alice.token)).send(body).expect(400);
  });

  test('users only see their own reports, with filtering and pagination', async () => {
    await createReport(ctx.app, alice.token);
    await createReport(ctx.app, alice.token, { message: SAFE });
    await createReport(ctx.app, bob.token);

    const all = await request(ctx.app).get('/api/reports').set(auth(alice.token));
    expect(all.body).toMatchObject({ total: 2, limit: 20, offset: 0 });
    expect(all.body.items.every((r) => r.userId === alice.user.id)).toBe(true);

    const high = await request(ctx.app).get('/api/reports?level=high').set(auth(alice.token));
    expect(high.body.items).toHaveLength(1);

    const page = await request(ctx.app).get('/api/reports?limit=1&offset=1').set(auth(alice.token));
    expect(page.body.items).toHaveLength(1);
    await request(ctx.app).get('/api/reports?limit=500').set(auth(alice.token)).expect(400);
  });

  test("reading someone else's report looks like it does not exist", async () => {
    const report = await createReport(ctx.app, alice.token);
    await request(ctx.app).get(`/api/reports/${report.id}`).set(auth(alice.token)).expect(200);
    await request(ctx.app).get(`/api/reports/${report.id}`).set(auth(bob.token)).expect(404);
    await request(ctx.app).get('/api/reports/99999').set(auth(alice.token)).expect(404);
    await request(ctx.app).get('/api/reports/abc').set(auth(alice.token)).expect(400);
  });

  test('updates status and notes, and rejects empty updates', async () => {
    const report = await createReport(ctx.app, alice.token);
    const res = await request(ctx.app).patch(`/api/reports/${report.id}`).set(auth(alice.token))
      .send({ status: 'confirmed_scam', notes: 'Reported to Scamwatch' });
    expect(res.status).toBe(200);
    expect(res.body.report).toMatchObject({ status: 'confirmed_scam', notes: 'Reported to Scamwatch' });

    await request(ctx.app).patch(`/api/reports/${report.id}`).set(auth(alice.token)).send({}).expect(400);
    await request(ctx.app).patch(`/api/reports/${report.id}`).set(auth(bob.token)).send({ status: 'open' }).expect(404);
  });

  test('deletes a report', async () => {
    const report = await createReport(ctx.app, alice.token);
    await request(ctx.app).delete(`/api/reports/${report.id}`).set(auth(bob.token)).expect(404);
    await request(ctx.app).delete(`/api/reports/${report.id}`).set(auth(alice.token)).expect(204);
    await request(ctx.app).get(`/api/reports/${report.id}`).set(auth(alice.token)).expect(404);
  });

  test('admins can see every report', async () => {
    const admin = await registerUser(ctx.app, { email: 'admin@example.test' });
    const report = await createReport(ctx.app, alice.token);
    await createReport(ctx.app, bob.token);

    const list = await request(ctx.app).get('/api/reports').set(auth(admin.token));
    expect(list.body.total).toBe(2);
    await request(ctx.app).get(`/api/reports/${report.id}`).set(auth(admin.token)).expect(200);
  });

  test('public statistics only contain aggregates', async () => {
    await createReport(ctx.app, alice.token);
    await createReport(ctx.app, bob.token, { message: SAFE });
    const res = await request(ctx.app).get('/api/stats');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 2,
      byLevel: { low: 1, medium: 0, high: 1 },
      byLanguage: { en: 2 },
      byStatus: { open: 2 },
    });
  });
});
