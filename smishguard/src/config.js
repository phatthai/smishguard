'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { z } = require('zod');
const pkg = require('../package.json');

const MIN_SECRET_LENGTH = 32;
const DEPLOYED_ENVIRONMENTS = new Set(['staging', 'production']);

const schema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9464),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_PATH: z.string().min(1).default('./data/smishguard.db'),
  JWT_SECRET: z.string().optional(),
  JWT_SECRET_FILE: z.string().optional(),
  JWT_EXPIRES_IN: z.string().regex(/^\d+[smhd]$/).default('1h'),
  ADMIN_EMAILS: z.string().default(''),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  CHECK_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
  APP_VERSION: z.string().min(1).default(`${pkg.version}-dev`),
  GIT_COMMIT: z.string().min(1).default('unknown'),
  BUILD_DATE: z.string().min(1).default('unknown'),
});

class ConfigError extends Error {}

function formatIssues(error) {
  return error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`).join('; ');
}

function readSecretFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch (err) {
    throw new ConfigError(`JWT_SECRET_FILE could not be read (${err.code || err.message})`);
  }
}

/**
 * Resolves the JWT signing secret. Deployed environments must provide a strong
 * secret (Jenkins injects it); local environments get a random per-process secret
 * so that no secret is ever hardcoded in the repository.
 */
function resolveJwtSecret(env) {
  const secret = env.JWT_SECRET_FILE ? readSecretFile(env.JWT_SECRET_FILE) : env.JWT_SECRET;
  if (secret && secret.length >= MIN_SECRET_LENGTH) {
    return secret;
  }
  if (DEPLOYED_ENVIRONMENTS.has(env.APP_ENV)) {
    throw new ConfigError(`JWT_SECRET must be set and at least ${MIN_SECRET_LENGTH} characters in ${env.APP_ENV}`);
  }
  return crypto.randomBytes(32).toString('hex');
}

function parseAdminEmails(value) {
  return value
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

function loadConfig(source = process.env) {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new ConfigError(`Invalid configuration: ${formatIssues(result.error)}`);
  }
  const env = result.data;
  return Object.freeze({
    env: env.APP_ENV,
    port: env.PORT,
    metricsPort: env.METRICS_PORT,
    logLevel: env.LOG_LEVEL,
    databasePath: env.DATABASE_PATH,
    jwt: Object.freeze({
      secret: resolveJwtSecret(env),
      expiresIn: env.JWT_EXPIRES_IN,
      issuer: 'smishguard',
      audience: 'smishguard-api',
    }),
    adminEmails: Object.freeze(parseAdminEmails(env.ADMIN_EMAILS)),
    rateLimit: Object.freeze({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
      checkMax: env.CHECK_RATE_LIMIT_MAX,
      loginMax: env.LOGIN_RATE_LIMIT_MAX,
    }),
    trustProxy: env.TRUST_PROXY === 'true',
    build: Object.freeze({
      version: env.APP_VERSION,
      commit: env.GIT_COMMIT,
      date: env.BUILD_DATE,
    }),
  });
}

module.exports = { loadConfig, ConfigError, MIN_SECRET_LENGTH };
