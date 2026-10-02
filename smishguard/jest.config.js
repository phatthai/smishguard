'use strict';

/** Unit + integration tests (run in the Test stage). */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  collectCoverageFrom: ['src/**/*.js'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text-summary', 'text', 'lcov', 'cobertura', 'json-summary'],
  // Pass/fail gate: the Test stage fails if coverage drops below these thresholds.
  coverageThreshold: {
    global: { statements: 90, branches: 80, functions: 90, lines: 90 },
  },
  reporters: [
    'default',
    ['jest-junit', {
      outputDirectory: 'reports/junit',
      outputName: 'unit-integration.xml',
      suiteName: 'SmishGuard unit and integration tests',
      classNameTemplate: '{filepath}',
      titleTemplate: '{title}',
      addFileAttribute: 'true',
    }],
  ],
  testTimeout: 15000,
};
