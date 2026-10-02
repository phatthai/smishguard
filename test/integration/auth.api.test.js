'use strict';

const jwt = require('jsonwebtoken');
const request = require('supertest');
const { buildTestApp, registerUser, uniqueEmail, metricValue, TEST_SECRET, TEST_PASSWORD } = require('../helpers/testApp');

describe('registration', () => {
  test('creates an account and returns a token without the password hash', async () => {
    const { app } = buildTestApp();
    const email = uniqueEmail();
    const res = await request(app).post('/api/auth/register').send({ email, password: TEST_PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email, role: 'user' });
    expect(res.body.user).not.toHaveProperty('passwordHash');
    expect(jwt.verify(res.body.token, TEST_SECRET)).toMatchObject({ sub: String(res.body.user.id), iss: 'smishguard' });
  });

  test('rejects duplicate emails regardless of case', async () => {
    const { app } = buildTestApp();
    const { email } = await registerUser(app);
    const res = await request(app).post('/api/auth/register').send({ email: email.toUpperCase(), password: TEST_PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  test.each([
    [{ email: 'not-an-email', password: TEST_PASSWORD }, 'email'],
    [{ email: 'a@example.com', password: 'short' }, 'password'],
  ])('validates input %#', async (body, field) => {
    const { app } = buildTestApp();
    const res = await request(app).post('/api/auth/register').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d) => d.field)).toContain(field);
  });

  test('emails listed in ADMIN_EMAILS get the admin role', async () => {
    const { app } = buildTestApp({ ADMIN_EMAILS: 'boss@example.test' });
    const { user } = await registerUser(app, { email: 'boss@example.test' });
    expect(user.role).toBe('admin');
  });
});

describe('login and tokens', () => {
  test('logs in and reads the current user', async () => {
    const { app, metrics } = buildTestApp();
    const { email, password } = await registerUser(app);
    const login = await request(app).post('/api/auth/login').send({ email: email.toUpperCase(), password });
    expect(login.status).toBe(200);

    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);
    expect(await metricValue(metrics, 'smishguard_auth_logins_total', { result: 'success' })).toBe(1);
  });

  test('wrong password and unknown email get the same generic answer', async () => {
    const { app, metrics } = buildTestApp();
    const { email } = await registerUser(app);
    const wrongPassword = await request(app).post('/api/auth/login').send({ email, password: 'WrongHorse42!' });
    const unknownUser = await request(app).post('/api/auth/login').send({ email: uniqueEmail(), password: TEST_PASSWORD });
    for (const res of [wrongPassword, unknownUser]) {
      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe('Invalid email or password');
    }
    expect(await metricValue(metrics, 'smishguard_auth_logins_total', { result: 'failure' })).toBe(2);
  });

  test.each([
    ['no header', null],
    ['wrong scheme', 'Basic abc'],
    ['garbage token', 'Bearer not-a-jwt'],
    ['token signed with another secret', `Bearer ${jwt.sign({ role: 'admin' }, 'another-secret-another-secret-12345', { subject: '1', issuer: 'smishguard', audience: 'smishguard-api' })}`],
    ['unsigned token (alg none)', `Bearer ${jwt.sign({ role: 'admin' }, null, { algorithm: 'none', subject: '1', issuer: 'smishguard', audience: 'smishguard-api' })}`],
  ])('rejects %s', async (_name, header) => {
    const { app } = buildTestApp();
    const req = request(app).get('/api/auth/me');
    const res = header ? await req.set('Authorization', header) : await req;
    expect(res.status).toBe(401);
  });

  test('rejects tokens for accounts that no longer exist', async () => {
    const { app, db } = buildTestApp();
    const { token, user } = await registerUser(app);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Account no longer exists');
  });

  test('login is rate limited and counted for security alerting', async () => {
    const { app, metrics } = buildTestApp({ LOGIN_RATE_LIMIT_MAX: '3' });
    const attempt = () => request(app).post('/api/auth/login').send({ email: 'attacker@example.test', password: 'guess-guess-1' });
    for (let i = 0; i < 3; i += 1) {
      expect((await attempt()).status).toBe(401);
    }
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(await metricValue(metrics, 'smishguard_auth_logins_total', { result: 'rate_limited' })).toBe(1);
  });
});
