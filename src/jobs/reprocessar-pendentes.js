'use strict';

// Resiliência a 503 (Frente 1, camada b/c) — reprocessamento do buffer "aguardando
// classificação" por TEMPO. Complementa o gatilho por EVENTO (nova mensagem, tratado
// no engine.processInbound).
//
// Para cada tenant ativo, pega os leads em status PENDING_CLASSIFICATION e manda o
// engine reclassificar pela CONVERSA INTEIRA (caminho classifyConversa, que classificou
// o Osvaldo certo). O engine resolve (funil/NOT_LEAD/Revisar) ou — esgotada a janela de
// 15min — joga pra Revisar com alerta ATIVO. Idempotente: lead resolvido sai do buffer.
//
// Cadência sugerida: a cada 2 min (ver server.js). A janela de 15min só estoura após
// ~7 ciclos falhando — tempo de sobra pra um spike de 503 do Google passar.

const { pool, withTenant } = require('../db');
const logger = require('../logger');
const engine = require('../engine');

// Leads no buffer deste tenant (mais antigos primeiro — quem está perto de estourar a
// janela é reprocessado antes). LIMIT defensivo: volume real é baixo (Valinhos).
async function pendentesDoTenant(c, tenantId) {
  return (await c.query(
    `SELECT id, phone, meta_psid, classification_pending_since
       FROM leads
      WHERE tenant_id = $1 AND status = 'PENDING_CLASSIFICATION'
      ORDER BY classification_pending_since ASC NULLS FIRST
      LIMIT 200`,
    [tenantId]
  )).rows;
}

// Um ciclo em todos os tenants ativos. deps injetáveis p/ teste.
async function runReprocessarPendentes(deps = {}) {
  const q = deps.pool || pool;
  const tenants = (await q.query('SELECT tenant_id FROM tenants_active()')).rows;
  const summary = { tenants: tenants.length, total: 0, resolved: 0, retained: 0, expired: 0 };
  for (const t of tenants) {
    const tenantId = t.tenant_id;
    try {
      const leads = await withTenant(tenantId, (c) => pendentesDoTenant(c, tenantId));
      summary.total += leads.length;
      for (const lead of leads) {
        try {
          const res = await engine.reprocessPendingLead({ id: tenantId }, lead, deps);
          if (res.status === 'resolved') summary.resolved += 1;
          else if (res.status === 'retained') summary.retained += 1;
          else if (res.status === 'expired_to_review') summary.expired += 1;
        } catch (err) {
          logger.error('reprocessar_pendentes.lead_error', { tenant_id: tenantId, lead_id: lead.id, error: err.message });
        }
      }
    } catch (err) {
      logger.error('reprocessar_pendentes.tenant_error', { tenant_id: tenantId, error: err.message });
    }
  }
  logger.info('reprocessar_pendentes.done', summary);
  return summary;
}

module.exports = { runReprocessarPendentes };
