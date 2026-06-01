'use strict';

const crypto = require('crypto');
const express = require('express');
const { pool, withTenant } = require('../db');
const { authenticate } = require('../auth');
const { requirePlatformAdmin } = require('../rbac');
const svc = require('../subscriptionService');
const { isUuid, isE164, isStringArray, validateBusinessHours } = require('../validation');
const { resolveSystemPrompt } = require('../templates');
const logger = require('../logger');

const FEATURES = ['LEAD_MANAGER', 'SCHEDULER'];
const DAY = 86400000;
const daysRemaining = (date) =>
  date ? Math.ceil((new Date(date).getTime() - Date.now()) / DAY) : null;

const router = express.Router();

// Monta a representação de resposta da config (inclui o prompt efetivo).
function present(row) {
  return {
    tenant_id: row.tenant_id,
    school_name: row.school_name,
    system_prompt_override: row.system_prompt_override,
    available_instruments: row.available_instruments,
    business_hours: row.business_hours,
    notification_whatsapp: row.notification_whatsapp,
    // Prompt resolvido: override, ou template padrão renderizado.
    system_prompt: resolveSystemPrompt(row),
    updated_at: row.updated_at,
  };
}

/**
 * PATCH /admin/tenants/:tenantId/lead-config
 * Cria ou atualiza (upsert parcial) a configuração de Lead Manager do tenant.
 * Protegido: somente role PLATFORM_ADMIN.
 */
async function patchLeadConfig(req, res) {
  const tenantId = req.params.tenantId;
  const log = logger.child({ tenant_id: tenantId, subject: req.user?.sub ?? null });

  if (!isUuid(tenantId)) {
    return res.status(400).json({ error: 'invalid tenantId' });
  }

  const body = req.body || {};

  // --- Validação dos campos enviados (PATCH: todos opcionais) ---
  if ('school_name' in body && (typeof body.school_name !== 'string' || !body.school_name.trim())) {
    return res.status(400).json({ error: 'school_name deve ser uma string não vazia' });
  }
  if (
    'system_prompt_override' in body &&
    body.system_prompt_override !== null &&
    typeof body.system_prompt_override !== 'string'
  ) {
    return res.status(400).json({ error: 'system_prompt_override deve ser string ou null' });
  }
  if ('available_instruments' in body && !isStringArray(body.available_instruments)) {
    return res.status(400).json({ error: 'available_instruments deve ser um array de strings' });
  }
  if ('business_hours' in body) {
    const err = validateBusinessHours(body.business_hours);
    if (err) return res.status(400).json({ error: err });
  }
  if (
    'notification_whatsapp' in body &&
    body.notification_whatsapp !== null &&
    !isE164(body.notification_whatsapp)
  ) {
    return res.status(400).json({
      error: 'notification_whatsapp deve estar no formato E.164 (ex: +5511999998888)',
    });
  }

  try {
    const result = await withTenant(tenantId, async (client) => {
      // Tenant precisa existir (e RLS já restringe a leitura à própria linha).
      const t = await client.query('SELECT 1 FROM tenants WHERE id = $1', [tenantId]);
      if (t.rowCount === 0) return { notFound: true };

      const existing = (
        await client.query('SELECT * FROM tenant_lead_config WHERE tenant_id = $1', [tenantId])
      ).rows[0];

      // Merge: campos enviados sobrescrevem; os demais preservam o existente.
      const merged = {
        school_name: 'school_name' in body ? body.school_name.trim() : existing?.school_name,
        system_prompt_override:
          'system_prompt_override' in body
            ? body.system_prompt_override
            : (existing?.system_prompt_override ?? null),
        available_instruments:
          'available_instruments' in body
            ? body.available_instruments
            : (existing?.available_instruments ?? []),
        business_hours:
          'business_hours' in body ? body.business_hours : (existing?.business_hours ?? {}),
        notification_whatsapp:
          'notification_whatsapp' in body
            ? body.notification_whatsapp
            : (existing?.notification_whatsapp ?? null),
      };

      // school_name é obrigatório na criação.
      if (!existing && !merged.school_name) {
        return { missingSchoolName: true };
      }

      const upserted = await client.query(
        `INSERT INTO tenant_lead_config
           (tenant_id, school_name, system_prompt_override,
            available_instruments, business_hours, notification_whatsapp)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (tenant_id) DO UPDATE SET
           school_name            = EXCLUDED.school_name,
           system_prompt_override = EXCLUDED.system_prompt_override,
           available_instruments  = EXCLUDED.available_instruments,
           business_hours         = EXCLUDED.business_hours,
           notification_whatsapp  = EXCLUDED.notification_whatsapp,
           updated_at             = now()
         RETURNING *`,
        [
          tenantId,
          merged.school_name,
          merged.system_prompt_override,
          merged.available_instruments,
          JSON.stringify(merged.business_hours),
          merged.notification_whatsapp,
        ]
      );
      return { row: upserted.rows[0], created: !existing };
    });

    if (result.notFound) {
      log.warn('admin.lead_config.tenant_not_found');
      return res.status(404).json({ error: 'tenant not found' });
    }
    if (result.missingSchoolName) {
      return res.status(400).json({ error: 'school_name é obrigatório ao criar a configuração' });
    }

    log.info(result.created ? 'admin.lead_config.created' : 'admin.lead_config.updated');
    return res.status(200).json({ created: result.created, config: present(result.row) });
  } catch (err) {
    log.error('admin.lead_config.error', { error: err.message });
    return res.status(500).json({ error: 'internal error' });
  }
}

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
