'use strict';

/**
 * Post-deployment end-to-end tests. They run against a live environment
 * (BASE_URL) after the Deploy and Release stages, so they must not import app code.
 */
const target = process.env.E2E_ENV || 'local';

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test-e2e'],
  testTimeout: 20000,
  reporters: [
    'default',
    ['jest-junit', {
      outputDirectory: 'reports/junit',
      outputName: `e2e-${target}.xml`,
      suiteName: `SmishGuard e2e (${target})`,
      classNameTemplate: `e2e.${target}.{classname}`,
      titleTemplate: '{title}',
    }],
  ],
};
