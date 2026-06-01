'use strict';

// Namespace self-service da unidade (ADR-004, Decisão 4): /tenant/:tenantId/*.
// Distinto de /admin/* (plataforma). Autorização por (tenant, role).

const express = require('express');
const { withTenant } = require('../db');
const { authenticate } = require('../auth');
const { requireTenantRole } = require('../rbac');
const logger = require('../logger');

const router = express.Router();

const READ_ROLES = ['TENANT_ADMIN', 'RECEPCAO', 'VISUALIZADOR'];

// Ver leads — leitura permitida a todos os papéis do tenant (ADR-004 §4b).
router.get(
  '/:tenantId/leads',
  authenticate,
  requireTenantRole(READ_ROLES),
  async (req, res) => {
    try {
      const leads = await withTenant(req.tenantId, (c) =>
        c.query(
          `SELECT id, name, phone, status, intent
             FROM leads ORDER BY created_at DESC LIMIT 100`
        )
      ).then((r) => r.rows);
      res.json({ tenant_id: req.tenantId, role: req.tenantRole, impersonation: req.impersonation, leads });
    } catch (err) {
      logger.error('tenant.leads.error', { tenant_id: req.tenantId, error: err.message });
      res.status(500).json({ error: 'internal error' });
    }
  }
);

// Gerenciar membros da unidade — somente TENANT_ADMIN.
router.get(
  '/:tenantId/members',
  authenticate,
  requireTenantRole(['TENANT_ADMIN']),
  async (req, res) => {
    try {
      const members = await withTenant(req.tenantId, (c) =>
        c.query('SELECT user_id, role, created_at FROM tenant_members ORDER BY created_at')
      ).then((r) => r.rows);
      res.json({ tenant_id: req.tenantId, role: req.tenantRole, members });
    } catch (err) {
      logger.error('tenant.members.error', { tenant_id: req.tenantId, error: err.message });
      res.status(500).json({ error: 'internal error' });
    }
  }
);

module.exports = router;
