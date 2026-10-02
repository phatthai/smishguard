'use strict';

const { AppError } = require('../utils/errors');

function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
}

/** Maps body-parser errors (malformed JSON, oversized bodies) onto clean API errors. */
function fromBodyParser(err) {
  if (err.type === 'entity.parse.failed') {
    return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
  if (err.type === 'entity.too.large') {
    return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }
  return null;
}

/**
 * Last middleware in the chain. Known errors become structured JSON responses;
 * anything unexpected is logged with its stack and returned as a generic 500 so
 * internal details never leak to clients.
 */
function errorHandler(logger) {
  // Express recognises error handlers by their four-argument signature.
  return (err, req, res, _next) => {
    const known = err instanceof AppError ? err : fromBodyParser(err);
    if (known) {
      const body = { code: known.code, message: known.message, ...(known.details ? { details: known.details } : {}) };
      return res.status(known.status).json({ error: body });
    }
    (req.log ?? logger).error({ err }, 'Unhandled error');
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
  };
}

module.exports = { notFoundHandler, errorHandler };
