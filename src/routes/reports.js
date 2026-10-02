'use strict';

const express = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { MAX_MESSAGE_LENGTH } = require('../services/riskEngine');

const RISK_LEVELS = ['low', 'medium', 'high'];
const CHANNELS = ['sms', 'email', 'phone', 'social', 'other'];
const STATUSES = ['open', 'confirmed_scam', 'false_positive'];

const idParams = z.object({ id: z.coerce.number().int().positive() });

const createBody = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  sender: z.string().trim().max(100).optional(),
  channel: z.enum(CHANNELS).default('sms'),
  notes: z.string().trim().max(500).optional(),
});

const listQuery = z.object({
  level: z.enum(RISK_LEVELS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const updateBody = z
  .object({
    status: z.enum(STATUSES).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .refine((body) => body.status !== undefined || body.notes !== undefined, {
    message: 'Provide status and/or notes',
  });

/** CRUD for scam reports. Every route requires authentication. */
function reportsRouter({ reportService, authenticate }) {
  const router = express.Router();
  router.use(authenticate);

  router.post('/', validate(createBody), (req, res) => {
    res.status(201).json(reportService.create(req.user, req.validated.body));
  });

  router.get('/', validate(listQuery, 'query'), (req, res) => {
    res.json(reportService.list(req.user, req.validated.query));
  });

  router.get('/:id', validate(idParams, 'params'), (req, res) => {
    res.json({ report: reportService.get(req.user, req.validated.params.id) });
  });

  router.patch('/:id', validate(idParams, 'params'), validate(updateBody), (req, res) => {
    res.json({ report: reportService.update(req.user, req.validated.params.id, req.validated.body) });
  });

  router.delete('/:id', validate(idParams, 'params'), (req, res) => {
    reportService.remove(req.user, req.validated.params.id);
    res.status(204).end();
  });

  return router;
}

module.exports = { reportsRouter };
