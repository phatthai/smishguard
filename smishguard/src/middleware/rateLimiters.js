'use strict';

const { rateLimit } = require('express-rate-limit');

function limitExceeded(message, onLimit) {
  return (req, res) => {
    onLimit?.(req);
    res.status(429).json({ error: { code: 'RATE_LIMITED', message } });
  };
}

/**
 * Rate limiters protect the API from abuse: a general limit for all API calls, a
 * tighter limit for the public check endpoint, and a strict limit on login to slow
 * down credential-stuffing and brute-force attempts (which also raise an alert).
 */
function createRateLimiters(config, metrics) {
  const common = { windowMs: config.rateLimit.windowMs, standardHeaders: 'draft-8', legacyHeaders: false };
  return {
    api: rateLimit({ ...common, limit: config.rateLimit.max, handler: limitExceeded('Too many requests, please slow down') }),
    check: rateLimit({ ...common, limit: config.rateLimit.checkMax, handler: limitExceeded('Too many checks, please try again shortly') }),
    login: rateLimit({
      ...common,
      limit: config.rateLimit.loginMax,
      handler: limitExceeded('Too many login attempts, please try again later', () => metrics.loginsTotal.inc({ result: 'rate_limited' })),
    }),
  };
}

module.exports = { createRateLimiters };
