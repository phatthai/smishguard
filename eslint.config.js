'use strict';

const js = require('@eslint/js');
const globals = require('globals');

/**
 * Code quality rules enforced in the Code Quality stage (zero warnings allowed).
 * The complexity and size limits keep functions small and readable; SonarCloud
 * then measures duplication, maintainability and coverage on top of this.
 */
const qualityRules = {
  complexity: ['error', 10],
  'max-depth': ['error', 3],
  'max-params': ['error', 4],
  'max-nested-callbacks': ['error', 3],
  'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
  'max-lines-per-function': ['error', { max: 60, skipBlankLines: true, skipComments: true }],
  eqeqeq: ['error', 'always'],
  curly: ['error', 'all'],
  'no-var': 'error',
  'prefer-const': 'error',
  'no-shadow': 'error',
  'no-param-reassign': 'error',
  'no-return-await': 'error',
  'consistent-return': 'error',
  'no-console': 'error',
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'all' }],
};

module.exports = [
  { ignores: ['node_modules/**', 'coverage/**', 'reports/**', 'data/**', '.scannerwork/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: qualityRules,
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
    rules: { 'max-lines': ['error', { max: 320, skipBlankLines: true, skipComments: true }] },
  },
  {
    files: ['test/**/*.js', 'test-e2e/**/*.js'],
    languageOptions: { globals: { ...globals.jest } },
    rules: { 'max-lines-per-function': 'off', 'max-nested-callbacks': ['error', 4] },
  },
  {
    files: ['scripts/**/*.js'],
    rules: { 'no-console': 'off' },
  },
];
