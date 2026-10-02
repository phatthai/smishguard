'use strict';

const jwt = require('jsonwebtoken');
const { hashPassword, verifyPassword } = require('./passwords');
const { conflict, unauthorized } = require('../utils/errors');

const INVALID_CREDENTIALS = 'Invalid email or password';

/**
 * Registration, login and token verification. Login failures always return the
 * same message and still run a hash comparison, so responses do not reveal
 * whether an email address is registered.
 */
function createAuthService({ userRepository, config, metrics }) {
  const { secret, expiresIn, issuer, audience } = config.jwt;
  const dummyHashPromise = hashPassword('timing-equaliser-not-a-real-account');

  function toPublicUser(user) {
    return { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt };
  }

  function issueToken(user) {
    return jwt.sign({ email: user.email, role: user.role }, secret, {
      algorithm: 'HS256',
      subject: String(user.id),
      expiresIn,
      issuer,
      audience,
    });
  }

  async function register({ email, password }) {
    const normalisedEmail = email.trim().toLowerCase();
    if (userRepository.findByEmail(normalisedEmail)) {
      throw conflict('An account with that email already exists');
    }
    const role = config.adminEmails.includes(normalisedEmail) ? 'admin' : 'user';
    const user = userRepository.create({ email: normalisedEmail, passwordHash: await hashPassword(password), role });
    metrics.registrationsTotal.inc();
    return { user: toPublicUser(user), token: issueToken(user) };
  }

  async function login({ email, password }) {
    const user = userRepository.findByEmail(email.trim().toLowerCase());
    const valid = await verifyPassword(password, user ? user.passwordHash : await dummyHashPromise);
    if (!user || !valid) {
      metrics.loginsTotal.inc({ result: 'failure' });
      throw unauthorized(INVALID_CREDENTIALS);
    }
    metrics.loginsTotal.inc({ result: 'success' });
    return { user: toPublicUser(user), token: issueToken(user) };
  }

  /** Verifies a bearer token. Algorithms are pinned to prevent algorithm-confusion attacks. */
  function verifyToken(token) {
    try {
      const payload = jwt.verify(token, secret, { algorithms: ['HS256'], issuer, audience });
      return { id: Number(payload.sub), email: payload.email, role: payload.role };
    } catch {
      throw unauthorized('Invalid or expired token');
    }
  }

  function getUser(id) {
    const user = userRepository.findById(id);
    if (!user) {
      throw unauthorized('Account no longer exists');
    }
    return toPublicUser(user);
  }

  return { register, login, verifyToken, getUser };
}

module.exports = { createAuthService };
