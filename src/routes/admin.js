'use strict';

const crypto = require('crypto');
const express = require('express');
const { pool, withTenant } = require('../db');
const { authenticate } = require('../auth');
const { requirePlatformAdmin } = require('../rbac');
const svc = require('../subscriptionService');
const { isUuid } = require('../validation');
const { patchLeadConfig } = require('../leadConfig');
const logger = require('../logger');

const FEATURES = ['LEAD_MANAGER', 'SCHEDULER'];
const DAY = 86400000;
const daysRemaining = (date) =>
  date ? Math.ceil((new Date(date).getTime() - Date.now()) / DAY) : null;

const router = express.Router();

// ---------------- E9-04: painel comercial (PLATFORM_ADMIN) ----------------

// Dias restantes conforme o estado: trial usa valid_until; grace usa grace_until.
function featureView(row) {
  if (!row.feature) return null;
  const ref = row.status === 'GRACE' ? row.grace_until : row.valid_until;
  return {
    feature: row.feature,
    status: row.status,
    valid_until: row.valid_until,
    grace_until: row.grace_until,
    days_remaining: daysRemaining(ref),
  };
}

// Lista tenants + status por feature + dias restantes.
async function listTenants(_req, res) {
  try {
    const { rows } = await pool.query('SELECT * FROM admin_tenant_overview()');
    const byTenant = new Map();
    for (const r of rows) {
      if (!byTenant.has(r.tenant_id)) {
        byTenant.set(r.tenant_id, {
          tenant_id: r.tenant_id,
          name: r.tenant_name,
          created_at: r.tenant_created_at,
          stripe_customer_id: r.stripe_customer_id,
          features: [],
        });
      }
      const fv = featureView(r);
      if (fv) byTenant.get(r.tenant_id).features.push(fv);
    }
    res.json({ tenants: [...byTenant.values()] });
  } catch (err) {
    logger.error('admin.tenants.error', { error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
}

// Cria tenant + ativa trial (duração customizável; default da plataforma).
async function createTenant(req, res) {
  const { name, feature = 'LEAD_MANAGER', trial_days } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name é obrigatório' });
  }
  if (!FEATURES.includes(feature)) {
    return res.status(400).json({ error: `feature inválida (use ${FEATURES.join('|')})` });
  }
  if (trial_days != null && (!Number.isInteger(trial_days) || trial_days <= 0)) {
    return res.status(400).json({ error: 'trial_days deve ser inteiro positivo' });
  }
  const tenantId = crypto.randomUUID();
  try {
    await withTenant(tenantId, (c) =>
      c.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, name.trim()])
    );
    const { subscription } = await svc.startTrial({
      tenantId,
      feature,
      days: trial_days,
      actor: req.user?.sub ?? null,
    });
    logger.info('admin.tenant.created', { tenant_id: tenantId, feature });
    res.status(201).json({ tenant_id: tenantId, name: name.trim(), subscription });
  } catch (err) {
    logger.error('admin.tenant.create_error', { error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
}

// Ação comercial sobre a assinatura de uma feature.
function subscriptionAction(action) {
  return async (req, res) => {
    const { tenantId, feature } = req.params;
    if (!isUuid(tenantId)) return res.status(400).json({ error: 'invalid tenantId' });
    if (!FEATURES.includes(feature)) return res.status(400).json({ error: 'feature inválida' });
    try {
      const result = await svc[action]({
        tenantId,
        feature,
        source: 'MANUAL',
        actor: req.user?.sub ?? null,
        idempotencyKey: req.body?.idempotencyKey,
      });
      res.json({ action, idempotent: result.idempotent, subscription: result.subscription });
    } catch (err) {
      logger.warn('admin.subscription.action_error', { action, tenant_id: tenantId, error: err.message });
      // assinatura inexistente etc.
      res.status(409).json({ error: err.message });
    }
  };
}

// Configura settings da plataforma (duração padrão de trial / grace).
async function patchSettings(req, res) {
  const { default_trial_days, grace_days } = req.body || {};
  if (default_trial_days != null && (!Number.isInteger(default_trial_days) || default_trial_days <= 0)) {
    return res.status(400).json({ error: 'default_trial_days deve ser inteiro positivo' });
  }
  if (grace_days != null && (!Number.isInteger(grace_days) || grace_days < 0)) {
    return res.status(400).json({ error: 'grace_days deve ser inteiro >= 0' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE platform_settings SET
         default_trial_days = COALESCE($1, default_trial_days),
         grace_days         = COALESCE($2, grace_days),
         updated_at = now()
       WHERE id = true
       RETURNING default_trial_days, grace_days`,
      [default_trial_days ?? null, grace_days ?? null]
    );
    res.json({ settings: rows[0] });
  } catch (err) {
    logger.error('admin.settings.error', { error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
}

// Métricas comerciais: trials ativos, taxa de conversão, MRR estimado.
async function getMetrics(_req, res) {
  try {
    const { rows } = await pool.query('SELECT * FROM admin_commercial_metrics()');
    const m = rows[0];
    const conversions = Number(m.conversions);
    const expirations = Number(m.expirations);
    const denom = conversions + expirations;
    res.json({
      active_trials: Number(m.active_trials),
      active_paid: Number(m.active_paid),
      conversions,
      expirations,
      conversion_rate: denom > 0 ? Number((conversions / denom).toFixed(4)) : null,
      estimated_mrr: Number(m.estimated_mrr),
    });
  } catch (err) {
    logger.error('admin.metrics.error', { error: err.message });
    res.status(500).json({ error: 'internal error' });
  }
}

// Todas as rotas /admin exigem PLATFORM_ADMIN (DB is_platform_admin).
router.patch('/tenants/:tenantId/lead-config', authenticate, requirePlatformAdmin(), patchLeadConfig);
router.get('/tenants', authenticate, requirePlatformAdmin(), listTenants);
router.post('/tenants', authenticate, requirePlatformAdmin(), createTenant);
router.post('/tenants/:tenantId/subscriptions/:feature/activate', authenticate, requirePlatformAdmin(), subscriptionAction('activate'));
router.post('/tenants/:tenantId/subscriptions/:feature/suspend', authenticate, requirePlatformAdmin(), subscriptionAction('suspend'));
router.post('/tenants/:tenantId/subscriptions/:feature/reactivate', authenticate, requirePlatformAdmin(), subscriptionAction('reactivate'));
router.patch('/settings', authenticate, requirePlatformAdmin(), patchSettings);
router.get('/metrics', authenticate, requirePlatformAdmin(), getMetrics);

module.exports = router;
