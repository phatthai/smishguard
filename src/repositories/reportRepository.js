'use strict';

function toReport(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    userId: row.user_id,
    message: row.message,
    sender: row.sender,
    channel: row.channel,
    language: row.language,
    riskScore: row.risk_score,
    riskLevel: row.risk_level,
    signals: JSON.parse(row.signals),
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function countBy(rows, key) {
  return rows.reduce((acc, row) => ({ ...acc, [row[key]]: row.count }), {});
}

/**
 * All statements are static and parameterised. Optional filters use the
 * "(:param IS NULL OR column = :param)" pattern, so no SQL is built from strings.
 */
function prepareStatements(db) {
  return {
    insert: db.prepare(`INSERT INTO reports
      (user_id, message, sender, channel, language, risk_score, risk_level, signals, notes)
      VALUES (:userId, :message, :sender, :channel, :language, :riskScore, :riskLevel, :signals, :notes)`),
    byId: db.prepare('SELECT * FROM reports WHERE id = ?'),
    list: db.prepare(`SELECT * FROM reports
      WHERE (:userId IS NULL OR user_id = :userId) AND (:level IS NULL OR risk_level = :level)
      ORDER BY created_at DESC, id DESC LIMIT :limit OFFSET :offset`),
    count: db.prepare(`SELECT COUNT(*) AS total FROM reports
      WHERE (:userId IS NULL OR user_id = :userId) AND (:level IS NULL OR risk_level = :level)`),
    update: db.prepare(`UPDATE reports SET
      status = COALESCE(:status, status),
      notes = COALESCE(:notes, notes),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = :id`),
    remove: db.prepare('DELETE FROM reports WHERE id = ?'),
    total: db.prepare('SELECT COUNT(*) AS total FROM reports'),
    byLevel: db.prepare('SELECT risk_level, COUNT(*) AS count FROM reports GROUP BY risk_level'),
    byLanguage: db.prepare('SELECT language, COUNT(*) AS count FROM reports GROUP BY language'),
    byStatus: db.prepare('SELECT status, COUNT(*) AS count FROM reports GROUP BY status'),
  };
}

/** Data access for scam reports. */
function createReportRepository(db) {
  const statements = prepareStatements(db);

  return {
    create(report) {
      const { lastInsertRowid } = statements.insert.run({
        userId: report.userId,
        message: report.message,
        sender: report.sender ?? null,
        channel: report.channel,
        language: report.language,
        riskScore: report.riskScore,
        riskLevel: report.riskLevel,
        signals: JSON.stringify(report.signals),
        notes: report.notes ?? null,
      });
      return toReport(statements.byId.get(Number(lastInsertRowid)));
    },
    findById(id) {
      return toReport(statements.byId.get(id));
    },
    list({ userId = null, level = null, limit = 20, offset = 0 } = {}) {
      const filter = { userId, level };
      const items = statements.list.all({ ...filter, limit, offset }).map(toReport);
      const { total } = statements.count.get(filter);
      return { items, total };
    },
    update(id, { status = null, notes = null }) {
      const { changes } = statements.update.run({ id, status, notes });
      return changes > 0 ? toReport(statements.byId.get(id)) : null;
    },
    remove(id) {
      return statements.remove.run(id).changes > 0;
    },
    stats() {
      return {
        total: statements.total.get().total,
        byLevel: { low: 0, medium: 0, high: 0, ...countBy(statements.byLevel.all(), 'risk_level') },
        byLanguage: countBy(statements.byLanguage.all(), 'language'),
        byStatus: countBy(statements.byStatus.all(), 'status'),
      };
    },
  };
}

module.exports = { createReportRepository };
