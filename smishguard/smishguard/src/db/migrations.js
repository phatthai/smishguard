'use strict';

/**
 * Ordered, append-only schema migrations. Each migration runs once and is
 * recorded in schema_migrations, so upgrades are repeatable in every environment.
 */
const MIGRATIONS = [
  {
    version: 1,
    name: 'create users and reports',
    sql: `
      CREATE TABLE users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE TABLE reports (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message     TEXT NOT NULL,
        sender      TEXT,
        channel     TEXT NOT NULL CHECK (channel IN ('sms', 'email', 'phone', 'social', 'other')),
        language    TEXT NOT NULL,
        risk_score  INTEGER NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
        risk_level  TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
        signals     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed_scam', 'false_positive')),
        notes       TEXT,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE INDEX idx_reports_user_created ON reports (user_id, created_at DESC);
      CREATE INDEX idx_reports_risk_level ON reports (risk_level);
    `,
  },
];

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version));
  const record = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      record.run(migration.version, migration.name);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return MIGRATIONS.length;
}

module.exports = { migrate, MIGRATIONS };
