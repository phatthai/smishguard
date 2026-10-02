'use strict';

/**
 * Code Quality stage, step 1: ESLint with complexity and size thresholds.
 * Prints a readable report, writes reports/eslint.json for SonarCloud, and fails on
 * any error or warning (zero-warning policy).
 */
const { ESLint } = require('eslint');
const { banner, info, main, writeJson } = require('./lib');

main(async () => {
  banner('ESLint: complexity <= 10, depth <= 3, params <= 4, function length <= 60');
  const eslint = new ESLint();
  const results = await eslint.lintFiles(['.']);
  const stylish = await eslint.loadFormatter('stylish');
  const report = await stylish.format(results);
  if (report) {
    console.log(report);
  }
  writeJson('reports/eslint.json', results);

  const errors = results.reduce((sum, result) => sum + result.errorCount, 0);
  const warnings = results.reduce((sum, result) => sum + result.warningCount, 0);
  info(`ESLint checked ${results.length} files: ${errors} errors, ${warnings} warnings`);
  if (errors > 0 || warnings > 0) {
    throw new Error('ESLint gate failed: fix the issues above (zero warnings allowed)');
  }
  info('ESLint gate passed');
});
