'use strict';

const pino = require('pino');

/**
 * Structured JSON logger. Logs go to stdout so Docker (and any log shipper)
 * can collect them; credentials are redacted before they are written.
 */
function createLogger({ level = 'info', env = 'development', version = 'dev' } = {}) {
  return pino({
    level,
    base: { service: 'smishguard', env, version },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'password', '*.password'],
      censor: '[REDACTED]',
    },
  });
}

module.exports = { createLogger };
