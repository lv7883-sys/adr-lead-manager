'use strict';

const express = require('express');
const { withTenant } = require('../db');
const { authenticate, requireRole } = require('../auth');
const { isUuid, isE164, isStringArray, validateBusinessHours } = require('../validation');
const { resolveSystemPrompt } = require('../templates');
const logger = require('../logger');

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

router.patch(
  '/tenants/:tenantId/lead-config',
  authenticate,
  requireRole('PLATFORM_ADMIN'),
  patchLeadConfig
);

module.exports = router;
