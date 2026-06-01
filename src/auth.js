'use strict';

const jwt = require('jsonwebtoken');
const logger = require('./logger');

// Verifica o Bearer JWT (assinado com JWT_SECRET) e popula req.user.
function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ error: 'missing bearer token' });
  }
  try {
    req.user = jwt.verify(match[1], process.env.JWT_SECRET);
    return next();
  } catch (err) {
    logger.warn('auth.invalid_token', { error: err.message });
    return res.status(401).json({ error: 'invalid token' });
  }
}

// Exige que o usuário autenticado possua a role indicada.
// Aceita tanto { role: 'X' } quanto { roles: ['X', ...] } no payload.
function requireRole(role) {
  return (req, res, next) => {
    const roles = Array.isArray(req.user?.roles)
      ? req.user.roles
      : req.user?.role
        ? [req.user.role]
        : [];
    if (!roles.includes(role)) {
      logger.warn('auth.forbidden', { required_role: role, subject: req.user?.sub ?? null });
      return res.status(403).json({ error: 'forbidden' });
    }
    return next();
  };
}

module.exports = { authenticate, requireRole };
