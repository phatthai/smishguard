'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, ConfigError, MIN_SECRET_LENGTH } = require('../../src/config');

const STRONG_SECRET = 'x'.repeat(MIN_SECRET_LENGTH);

describe('configuration', () => {
  test('uses safe defaults for local development', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ env: 'development', port: 3000, metricsPort: 9464, logLevel: 'info', trustProxy: false });
    expect(config.jwt.secret).toHaveLength(64);
    expect(config.build.version).toMatch(/-dev$/);
    expect(Object.isFrozen(config)).toBe(true);
  });

  test('generates a different random secret per process in development', () => {
    expect(loadConfig({}).jwt.secret).not.toBe(loadConfig({}).jwt.secret);
  });

  test.each(['staging', 'production'])('%s refuses to start without a strong JWT secret', (env) => {
    expect(() => loadConfig({ APP_ENV: env })).toThrow(ConfigError);
    expect(() => loadConfig({ APP_ENV: env, JWT_SECRET: 'too-short' })).toThrow(/at least 32 characters/);
  });

  test('reads the JWT secret from a file (Docker secret style)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smishguard-'));
    const file = path.join(dir, 'jwt_secret');
    fs.writeFileSync(file, `${STRONG_SECRET}\n`);
    expect(loadConfig({ APP_ENV: 'production', JWT_SECRET_FILE: file }).jwt.secret).toBe(STRONG_SECRET);
  });

  test('reports a missing secret file clearly', () => {
    expect(() => loadConfig({ APP_ENV: 'production', JWT_SECRET_FILE: '/nope/missing' })).toThrow(/could not be read/);
  });

  test('rejects invalid values with the field name', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ APP_ENV: 'qa' })).toThrow(/APP_ENV/);
    expect(() => loadConfig({ JWT_EXPIRES_IN: 'forever' })).toThrow(/JWT_EXPIRES_IN/);
  });

  test('parses admin emails, rate limits and proxy settings', () => {
    const config = loadConfig({
      ADMIN_EMAILS: ' Admin@Example.com, ops@example.com ,',
      LOGIN_RATE_LIMIT_MAX: '5',
      TRUST_PROXY: 'true',
      APP_VERSION: '1.0.42',
      GIT_COMMIT: 'abc1234',
    });
    expect(config.adminEmails).toEqual(['admin@example.com', 'ops@example.com']);
    expect(config.rateLimit.loginMax).toBe(5);
    expect(config.trustProxy).toBe(true);
    expect(config.build).toMatchObject({ version: '1.0.42', commit: 'abc1234' });
  });
});
