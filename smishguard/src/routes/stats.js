'use strict';

const express = require('express');

/** Public, aggregate-only statistics (no message content or personal data). */
function statsRouter({ reportService }) {
  const router = express.Router();
  router.get('/', (_req, res) => {
    res.json(reportService.stats());
  });
  return router;
}

module.exports = { statsRouter };
