'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase, isDatabaseHealthy } = require('../../src/db/database');
const { migrate, MIGRATIONS } = require('../../src/db/migrations');
const { createUserRepository } = require('../../src/repositories/userRepository');
const { createReportRepository } = require('../../src/repositories/reportRepository');

function seedReport(reports, userId, overrides = {}) {
  return reports.create({
    userId,
    message: 'Pay the toll now',
    channel: 'sms',
    language: 'en',
    riskScore: 45,
    riskLevel: 'medium',
    signals: ['payment_request'],
    ...overrides,
  });
}

describe('database', () => {
  test('creates the data directory, enables WAL and reports health', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smishguard-db-'));
    const db = openDatabase(path.join(dir, 'nested', 'app.db'));
    expect(db.prepare('PRAGMA journal_mode').get().journal_mode).toBe('wal');
    expect(isDatabaseHealthy(db)).toBe(true);
    db.close();
    expect(isDatabaseHealthy(db)).toBe(false);
  });

  test('migrations are idempotent', () => {
    const db = openDatabase(':memory:');
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n).toBe(MIGRATIONS.length);
  });

  test('a failing migration is rolled back', () => {
    const db = openDatabase(':memory:');
    MIGRATIONS.push({ version: 999, name: 'broken', sql: 'CREATE TABLE broken (id INTEGER); SELECT * FROM missing_table;' });
    try {
      expect(() => migrate(db)).toThrow();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'broken'").get()).toBeUndefined();
    } finally {
      MIGRATIONS.pop();
    }
  });
});

describe('user repository', () => {
  test('creates and finds users (email lookup is case-insensitive)', () => {
    const users = createUserRepository(openDatabase(':memory:'));
    const created = users.create({ email: 'mike@example.com', passwordHash: 'hash' });
    expect(created).toMatchObject({ id: 1, email: 'mike@example.com', role: 'user' });
    expect(users.findByEmail('MIKE@example.com').id).toBe(created.id);
    expect(users.findById(created.id).email).toBe('mike@example.com');
    expect(users.findById(999)).toBeNull();
  });
});

describe('report repository', () => {
  let reports;
  let owner;
  let other;

  beforeEach(() => {
    const db = openDatabase(':memory:');
    const users = createUserRepository(db);
    owner = users.create({ email: 'owner@example.com', passwordHash: 'h' });
    other = users.create({ email: 'other@example.com', passwordHash: 'h' });
    reports = createReportRepository(db);
  });

  test('creates reports and maps rows to objects', () => {
    const report = seedReport(reports, owner.id, { sender: '+61400000000', notes: 'got this today' });
    expect(report).toMatchObject({ userId: owner.id, riskLevel: 'medium', signals: ['payment_request'], status: 'open', sender: '+61400000000' });
    expect(reports.findById(report.id)).toEqual(report);
    expect(reports.findById(12345)).toBeNull();
  });

  test('lists with owner filter, level filter and pagination', () => {
    seedReport(reports, owner.id);
    seedReport(reports, owner.id, { riskLevel: 'high', riskScore: 90 });
    seedReport(reports, other.id, { riskLevel: 'high', riskScore: 80 });

    expect(reports.list({ userId: owner.id }).total).toBe(2);
    expect(reports.list({ level: 'high' }).total).toBe(2);
    expect(reports.list({ userId: owner.id, level: 'high' }).items).toHaveLength(1);
    const page = reports.list({ limit: 1, offset: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  test('updates, deletes and aggregates statistics', () => {
    const report = seedReport(reports, owner.id);
    seedReport(reports, other.id, { riskLevel: 'high', riskScore: 90, language: 'vi' });

    expect(reports.update(report.id, { status: 'confirmed_scam' })).toMatchObject({ status: 'confirmed_scam', notes: null });
    expect(reports.update(report.id, { notes: 'reported to Scamwatch' })).toMatchObject({ status: 'confirmed_scam', notes: 'reported to Scamwatch' });
    expect(reports.update(999, { status: 'open' })).toBeNull();

    expect(reports.stats()).toEqual({
      total: 2,
      byLevel: { low: 0, medium: 1, high: 1 },
      byLanguage: { en: 1, vi: 1 },
      byStatus: { confirmed_scam: 1, open: 1 },
    });
    expect(reports.remove(report.id)).toBe(true);
    expect(reports.remove(report.id)).toBe(false);
  });
});
