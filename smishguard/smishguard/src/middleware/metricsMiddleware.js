'use strict';

/**
 * Records RED metrics (rate, errors, duration) for every request. The route label
 * uses the matched route pattern (e.g. /api/reports/:id), never the raw URL, to keep
 * metric cardinality bounded.
 */
function routeLabel(req, res) {
  if (req.route) {
    return `${req.baseUrl}${req.route.path === '/' && req.baseUrl ? '' : req.route.path}`;
  }
  return res.statusCode === 404 ? 'unmatched' : 'static';
}

function metricsMiddleware(metrics) {
  return (req, res, next) => {
    const stopTimer = metrics.httpRequestDuration.startTimer();
    res.on('finish', () => {
      const labels = { method: req.method, route: routeLabel(req, res), status_code: String(res.statusCode) };
      stopTimer(labels);
      metrics.httpRequestsTotal.inc(labels);
    });
    next();
  };
}

module.exports = { metricsMiddleware, routeLabel };
