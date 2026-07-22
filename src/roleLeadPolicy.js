'use strict';
//
// roleLeadPolicy.js — MOTOR da política papel→resgate (ADR-036 E1.4/E1.5), config-as-data.
// Lê a política do TENANT ATUAL a partir de role_lead_policy (nunca hardcode de texto). O core
// não conhece a pergunta: pede a do papel casado por _lookupRole e injeta no classificador.
//
// DEFAULT SEGURO: papel sem linha no tenant → { default_action: 'vigia', rescue_prompt: null }.
// 'vigia' = NUNCA descarta silencioso (vai pro Revisar / humano decide); sem rescue_prompt, o
// classificador segue genérico. Escolha conservadora: precisão sobre recall p/ conhecido
// (ADR-036 rollout) — nada de descarte cego sem pergunta configurada. O skip é LOGADO
// (rescue.policy.nao_semeada) para tornar visível a falta do seed por-tenant.
//
const { withTenant } = require('./db');
const logger = require('./logger');

const SAFE_DEFAULT = Object.freeze({ default_action: 'vigia', rescue_prompt: null, rescue_scope: 'estreito', seeded: false });

// Política de resgate do (tenant, papel). Best-effort: qualquer falha → default seguro.
async function getRescuePolicy(tenantId, roleKey) {
  if (!tenantId || !roleKey) return { ...SAFE_DEFAULT };
  try {
    const r = await withTenant(tenantId, (c) => c.query(
      `SELECT default_action, rescue_prompt, rescue_scope
         FROM lead_manager.role_lead_policy
        WHERE tenant_id = $1 AND role = $2`,
      [tenantId, roleKey]));
    const row = r.rows[0];
    if (!row) {
      logger.warn('rescue.policy.nao_semeada', {
        tenant_id: tenantId, role: roleKey,
        detail: 'papel sem política de resgate no tenant — usando default seguro (vigia, sem resgate); falta o seed por-tenant',
      });
      return { ...SAFE_DEFAULT };
    }
    return { default_action: row.default_action, rescue_prompt: row.rescue_prompt, rescue_scope: row.rescue_scope, seeded: true };
  } catch (e) {
    logger.warn('rescue.policy.read_failed', { tenant_id: tenantId, role: roleKey, error: e.message });
    return { ...SAFE_DEFAULT };
  }
}

module.exports = { getRescuePolicy, SAFE_DEFAULT };
