'use strict';

/**
 * Pure logic for the custom quality policy: evaluates SonarCloud measures against the
 * thresholds in policies/quality-policy.json and summarises metric trends over time.
 */

function compare(value, op, threshold) {
  return op === '>=' ? value >= threshold : value <= threshold;
}

/** Evaluates each condition using the first metric key SonarCloud actually returned. */
function evaluateQuality(measures, policy) {
  const results = policy.conditions.map((condition) => {
    const metric = condition.metrics.find((key) => measures[key] !== undefined);
    if (!metric) {
      return { ...condition, metric: condition.metrics[0], value: null, status: 'n/a' };
    }
    const value = Number(measures[metric]);
    return { ...condition, metric, value, status: compare(value, condition.op, condition.threshold) ? 'pass' : 'fail' };
  });
  return { passed: results.every((result) => result.status !== 'fail'), results };
}

/** Summarises SonarCloud measure history: first vs latest value over the last N analyses. */
function summariseTrend(history, points = 6) {
  return (history?.measures ?? []).map((measure) => {
    const series = measure.history.filter((entry) => entry.value !== undefined).slice(-points);
    const values = series.map((entry) => Number(entry.value));
    const first = values[0];
    const last = values.at(-1);
    return {
      metric: measure.metric,
      analyses: values.length,
      series: values,
      first: first ?? null,
      last: last ?? null,
      change: values.length > 1 ? Number((last - first).toFixed(2)) : 0,
    };
  });
}

/** Parses a Java-style .properties file (key=value lines, # comments). */
function parseProperties(text) {
  return Object.fromEntries(text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
}

module.exports = { evaluateQuality, summariseTrend, parseProperties };
