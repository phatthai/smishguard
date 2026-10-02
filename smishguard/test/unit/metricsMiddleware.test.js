'use strict';

const { routeLabel } = require('../../src/middleware/metricsMiddleware');

describe('metrics route labels', () => {
  test.each([
    [{ baseUrl: '/api/reports', route: { path: '/:id' } }, 200, '/api/reports/:id'],
    [{ baseUrl: '/api/reports', route: { path: '/' } }, 200, '/api/reports'],
    [{ baseUrl: '', route: { path: '/health' } }, 200, '/health'],
    [{ baseUrl: '' }, 404, 'unmatched'],
    [{ baseUrl: '' }, 200, 'static'],
  ])('%o with status %i -> %s', (req, statusCode, expected) => {
    expect(routeLabel(req, { statusCode })).toBe(expected);
  });
});
