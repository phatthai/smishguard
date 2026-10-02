'use strict';

const express = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');

const credentials = z.object({
  email: z.email().max(254),
  password: z.string().min(10, 'Password must be at least 10 characters').max(128),
});

const loginBody = z.object({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(128),
});

function authRouter({ authService, limiters, authenticate }) {
  const router = express.Router();

  router.post('/register', limiters.login, validate(credentials), async (req, res) => {
    const result = await authService.register(req.validated.body);
    res.status(201).json(result);
  });

  router.post('/login', limiters.login, validate(loginBody), async (req, res) => {
    res.json(await authService.login(req.validated.body));
  });

  router.get('/me', authenticate, (req, res) => {
    res.json({ user: authService.getUser(req.user.id) });
  });

  return router;
}

module.exports = { authRouter };
