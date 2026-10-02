'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { migrate } = require('./migrations');

const IN_MEMORY = ':memory:';

/**
 * Opens the SQLite database using Node's built-in driver (no native build step),
 * applies pragmas for durability and concurrency, then runs pending migrations.
 */
function openDatabase(databasePath) {
  if (databasePath !== IN_MEMORY) {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  if (databasePath !== IN_MEMORY) {
    db.exec('PRAGMA journal_mode = WAL;');
  }
  migrate(db);
  return db;
}

function isDatabaseHealthy(db) {
  try {
    return db.prepare('SELECT 1 AS ok').get().ok === 1;
  } catch {
    return false;
  }
}

module.exports = { openDatabase, isDatabaseHealthy, IN_MEMORY };
