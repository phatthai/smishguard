'use strict';

const { badRequest } = require('../utils/errors');

/**
 * Validates req[source] against a zod schema. Parsed values are stored on
 * req.validated[source]; Express 5 makes req.query read-only, so the original
 * request object is never mutated.
 */
function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source] ?? {});
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }));
      return next(badRequest('Request validation failed', details));
    }
    req.validated = { ...req.validated, [source]: result.data };
    return next();
  };
}

module.exports = { validate };
