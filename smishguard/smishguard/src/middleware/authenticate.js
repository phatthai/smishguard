'use strict';

const { unauthorized } = require('../utils/errors');

const BEARER_PREFIX = 'Bearer ';

/** Requires a valid "Authorization: Bearer <jwt>" header and sets req.user. */
function authenticate(authService) {
  return (req, _res, next) => {
    const header = req.get('authorization') ?? '';
    if (!header.startsWith(BEARER_PREFIX)) {
      return next(unauthorized());
    }
    try {
      req.user = authService.verifyToken(header.slice(BEARER_PREFIX.length).trim());
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { authenticate };
