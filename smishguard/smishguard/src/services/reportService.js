'use strict';

const { assessMessage } = require('./riskEngine');
const { notFound } = require('../utils/errors');

/**
 * Scam report use cases. Users can only see and change their own reports; admins
 * can see everything. Reports owned by someone else return 404 rather than 403 so
 * the API does not confirm which report IDs exist.
 */
function createReportService({ reportRepository, metrics }) {
  const canAccess = (user, report) => report && (user.role === 'admin' || report.userId === user.id);

  function getOwned(user, id) {
    const report = reportRepository.findById(id);
    if (!canAccess(user, report)) {
      throw notFound('Report not found');
    }
    return report;
  }

  function create(user, { message, sender, channel, notes }) {
    const assessment = assessMessage(message);
    const report = reportRepository.create({
      userId: user.id,
      message,
      sender,
      channel,
      notes,
      language: assessment.language,
      riskScore: assessment.score,
      riskLevel: assessment.level,
      signals: assessment.signals.map((signal) => signal.id),
    });
    metrics.reportsCreatedTotal.inc({ risk_level: report.riskLevel });
    metrics.checksTotal.inc({ risk_level: assessment.level, language: assessment.language, source: 'report' });
    metrics.riskScore.observe(assessment.score);
    return { report, assessment };
  }

  function list(user, { level, limit, offset }) {
    const userId = user.role === 'admin' ? null : user.id;
    const { items, total } = reportRepository.list({ userId, level: level ?? null, limit, offset });
    return { items, total, limit, offset };
  }

  function update(user, id, changes) {
    getOwned(user, id);
    return reportRepository.update(id, { status: changes.status ?? null, notes: changes.notes ?? null });
  }

  function remove(user, id) {
    getOwned(user, id);
    reportRepository.remove(id);
  }

  return { create, list, get: getOwned, update, remove, stats: () => reportRepository.stats() };
}

module.exports = { createReportService };
