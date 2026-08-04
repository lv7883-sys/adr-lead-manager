'use strict';

// Handler compartilhado de configuração de Lead Manager por tenant (E7-01).
// Reutilizado por dois namespaces (E9-06):
//   - /admin/tenants/:tenantId/lead-config   (PLATFORM_ADMIN)
//   - /tenant/:tenantId/lead-config          (TENANT_ADMIN do próprio tenant)
// A autorização é feita pelo middleware da rota; aqui só a lógica de negócio.

const { withTenant } = require('./db');
const { isUuid, isE164, isStringArray } = require('./validation');
const { resolveSystemPrompt } = require('./templates');
const { textoHorario } = require('./horario');
const { horarioFonte } = require('./promptConfig');
const logger = require('./logger');

// Representação de resposta da config (inclui o prompt efetivo).
// `row` deve trazer horario_texto (fonte única tenants.horario_comercial) — quem
// monta o row (patchLeadConfig) o injeta. O horário NÃO vive mais nesta config.
function present(row) {
  return {
    tenant_id: row.tenant_id,
    school_name: row.school_name,
    system_prompt_override: row.system_prompt_override,
    available_instruments: row.available_instruments,
    notification_whatsapp: row.notification_whatsapp,
    // ADR sugestão-de-etapa: definições por etapa que alimentam o detector (key→descrição).
    stage_definitions: row.stage_definitions || null,
    // Prompt resolvido: override, ou template padrão renderizado (horário da fonte única).
    system_prompt: resolveSystemPrompt(row),
    updated_at: row.updated_at,
  };
}

/**
 * PATCH lead-config — cria ou atualiza (upsert parcial) a config do tenant.
 * Usa req.params.tenantId (presente nos dois namespaces).
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
  // Horário de atendimento NÃO é mais configurado aqui: fonte única = aba
  // "Horário de atendimento" (PUT /tenant/:id/horario-comercial → tenants.horario_comercial).
  // Um business_hours enviado no corpo é ignorado (mantido só p/ retrocompat de chamadas antigas).
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
            available_instruments, notification_whatsapp)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id) DO UPDATE SET
           school_name            = EXCLUDED.school_name,
           system_prompt_override = EXCLUDED.system_prompt_override,
           available_instruments  = EXCLUDED.available_instruments,
           notification_whatsapp  = EXCLUDED.notification_whatsapp,
           updated_at             = now()
         RETURNING *`,
        [
          tenantId,
          merged.school_name,
          merged.system_prompt_override,
          merged.available_instruments,
          merged.notification_whatsapp,
        ]
      );
      // Horário do prompt = FONTE ÚNICA tenants.horario_comercial (aba), nunca a config.
      const tHor = (await client.query(
        `SELECT horario_comercial,
                to_char(horario_comercial_inicio, 'HH24:MI') AS hc_inicio,
                to_char(horario_comercial_fim, 'HH24:MI') AS hc_fim,
                horario_comercial_dias AS hc_dias
           FROM tenants WHERE id = $1`, [tenantId])).rows[0] || {};
      const row = { ...upserted.rows[0], horario_texto: textoHorario(horarioFonte(tHor)) };
      return { row, created: !existing };
    });

    if (result.notFound) {
      log.warn('lead_config.tenant_not_found');
      return res.status(404).json({ error: 'tenant not found' });
    }
    if (result.missingSchoolName) {
      return res.status(400).json({ error: 'school_name é obrigatório ao criar a configuração' });
    }

    log.info(result.created ? 'lead_config.created' : 'lead_config.updated');
    return res.status(200).json({ created: result.created, config: present(result.row) });
  } catch (err) {
    log.error('lead_config.error', { error: err.message });
    return res.status(500).json({ error: 'internal error' });
  }
}

module.exports = { patchLeadConfig, present };
