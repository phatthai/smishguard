'use strict';

const express = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { assessMessage, MAX_MESSAGE_LENGTH } = require('../services/riskEngine');

const checkBody = z.object({
  message: z.string().trim().min(1, 'Message is required').max(MAX_MESSAGE_LENGTH),
});

/** Public endpoint: scores a message without storing it (privacy by design). */
function checkRouter({ limiters, metrics }) {
  const router = express.Router();

  router.post('/', limiters.check, validate(checkBody), (req, res) => {
    const assessment = assessMessage(req.validated.body.message);
    metrics.checksTotal.inc({ risk_level: assessment.level, language: assessment.language, source: 'check' });
    metrics.riskScore.observe(assessment.score);
    res.json(assessment);
  });

  return router;
}

module.exports = { checkRouter };
