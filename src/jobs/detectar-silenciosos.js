'use strict';

// ADR-020 (parcial) — job diário de detecção de leads silenciosos.
//
// Para cada tenant ativo, encontra leads ativos (QUALIFYING/QUALIFIED) cujo
// ÚLTIMO contato foi DA ESCOLA (outbound) e o cliente não respondeu depois,
// classifica por faixa de silêncio (3/7/15/30 dias) e — para os que ainda não
// têm tentativa de reabordagem nos últimos 3 dias — gera uma sugestão via IA e
// grava em reabordagem_tentativas com status='pendente' (aguardando aprovação
// da recepção, que vê na fila). Idempotente: a janela de 3 dias evita repetir.

const { pool, withTenant } = require('../db');
const gemini = require('../gemini');
const redisClient = require('../redisClient');
const { resolveSystemPrompt } = require('../templates');
const logger = require('../logger');

const RETOMADA_CACHE_TTL = 24 * 3600;

// Faixa de silêncio pelo tempo (segundos) desde o último contato da escola.
function faixaDe(silencioSeg) {
  const dias = silencioSeg / 86400;
  if (dias >= 30) return 'ultimo';
  if (dias >= 15) return 'critico';
  if (dias >= 7) return 'medio';
  return 'leve';        // >= 3 dias (filtro garante o piso)
}

// Leads silenciosos do tenant que ainda precisam de uma sugestão de reabordagem.
async function leadsSilenciosos(c, tenantId) {
  return (await c.query(
    `WITH inb AS (
       SELECT regexp_replace(cv.external_id, '[^0-9]', '', 'g') AS ident, max(m.received_at) AS last_in
         FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
        WHERE cv.tenant_id = $1 AND m.role = 'USER' GROUP BY 1
     ),
     outb AS (
       SELECT regexp_replace(s.external_id, '[^0-9]', '', 'g') AS ident, max(s.received_at) AS last_out
         FROM staff_outbound_samples s
        WHERE s.tenant_id = $1 AND coalesce(s.raw->'data'->'key'->>'remoteJid', '') NOT LIKE '%@g.us'
        GROUP BY 1
     )
     SELECT l.id, l.name, l.phone, l.meta_psid,
            EXTRACT(EPOCH FROM (now() - o.last_out))::bigint AS silencio_seg
       FROM leads l
       LEFT JOIN inb  i ON i.ident = regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')
       LEFT JOIN outb o ON o.ident = regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')
      WHERE l.status IN ('QUALIFYING', 'QUALIFIED')
        AND l.desfecho IS NULL
        AND o.last_out IS NOT NULL
        AND (i.last_in IS NULL OR o.last_out > i.last_in)          -- último contato foi DA escola
        AND o.last_out < now() - interval '3 days'                 -- silêncio >= 3 dias
        AND NOT EXISTS (
              -- #8 Fase 2: NÃO regenera enquanto houver um 'pendente' aberto pro lead
              -- (antes o dedup só olhava janela de 3d via enviado_em, mas 'pendente' tinha
              -- enviado_em=DEFAULT now() → após 3d regenerava → acúmulo de duplicatas).
              SELECT 1 FROM reabordagem_tentativas rt
               WHERE rt.lead_id = l.id
                 AND (rt.status = 'pendente' OR rt.enviado_em > now() - interval '3 days')
            )
      ORDER BY o.last_out ASC`,
    [tenantId]
  )).rows;
}

// Histórico da conversa (lead + recepção) p/ dar contexto à IA — mesmo formato
// usado pelo endpoint /sugestao-retomada.
async function historico(c, tenantId, ident) {
  if (!ident) return [];
  return (await c.query(
    `SELECT role, content FROM (
       SELECT m.received_at, 'USER' AS role, coalesce(m.media_transcription, m.body) AS content
         FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
        WHERE cv.tenant_id = $1 AND regexp_replace(cv.external_id, '[^0-9]', '', 'g') = $2
          AND coalesce(m.media_transcription, m.body) IS NOT NULL
       UNION ALL
       SELECT s.received_at, 'ASSISTANT' AS role, s.body AS content
         FROM staff_outbound_samples s
        WHERE s.tenant_id = $1 AND regexp_replace(s.external_id, '[^0-9]', '', 'g') = $2
          AND coalesce(s.raw->'data'->'key'->>'remoteJid', '') NOT LIKE '%@g.us' AND s.body IS NOT NULL
     ) t ORDER BY received_at ASC LIMIT 40`,
    [tenantId, ident]
  )).rows;
}

// Processa um tenant: gera sugestões pendentes para seus leads silenciosos.
async function processarTenant(tenantId) {
  const resumo = { tenant_id: tenantId, detectados: 0, sugeridos: 0, faixas: {} };
  const leads = await withTenant(tenantId, (c) => leadsSilenciosos(c, tenantId));
  resumo.detectados = leads.length;
  if (!leads.length) return resumo;

  // Contexto da escola (uma vez por tenant).
  const cfg = await withTenant(tenantId, async (c) => {
    const config = (await c.query(
      `SELECT school_name, system_prompt_override, available_instruments, business_hours, notification_whatsapp
         FROM tenant_lead_config WHERE tenant_id = $1`, [tenantId]
    )).rows[0];
    const tname = (await c.query('SELECT name FROM tenants WHERE id = $1', [tenantId])).rows[0]?.name;
    return { config, tname };
  });
  const schoolContext = resolveSystemPrompt(cfg.config || { school_name: cfg.tname || 'Escola', system_prompt_override: null });

  for (const lead of leads) {
    const faixa = faixaDe(Number(lead.silencio_seg));
    try {
      const ident = String(lead.phone || lead.meta_psid || '').replace(/\D/g, '');
      const convo = await withTenant(tenantId, (c) => historico(c, tenantId, ident));
      const sug = await gemini.sugestaoRetomada({ history: convo, leadName: lead.name, schoolContext });
      if (!sug || !sug.rascunho) { logger.warn('silenciosos.sem_rascunho', { tenant_id: tenantId, lead_id: lead.id }); continue; }
      await withTenant(tenantId, (c) => c.query(
        // #8 Fase 2: enviado_em=NULL explícito — 'pendente' não é envio; enviado_em passa a
        // significar SÓ "enviado de verdade" (migração 073 dropa o DEFAULT now()).
        `INSERT INTO reabordagem_tentativas
           (tenant_id, lead_id, texto, sugestao_estrategia, sugestao_rascunho, status, enviado_em)
         VALUES ($1, $2, $3, $4, $5, 'pendente', NULL)`,
        [tenantId, lead.id, sug.rascunho, sug.estrategia || null, sug.rascunho]
      ));
      // Deixa a sugestão quentinha no cache p/ a fila exibir na hora (mesma key
      // do endpoint /sugestao-retomada).
      try { await redisClient.setCache(`retomada:${tenantId}:${lead.id}`, sug, RETOMADA_CACHE_TTL); } catch { /* best-effort */ }
      resumo.sugeridos += 1;
      resumo.faixas[faixa] = (resumo.faixas[faixa] || 0) + 1;
    } catch (err) {
      logger.error('silenciosos.lead_error', { tenant_id: tenantId, lead_id: lead.id, error: err.message });
    }
  }
  return resumo;
}

// Executa um ciclo do job em todos os tenants ativos. deps injetáveis p/ teste.
async function runDetectarSilenciosos(deps = {}) {
  const q = deps.pool || pool;
  const tenants = (await q.query('SELECT tenant_id FROM tenants_active()')).rows;
  const summary = { tenants: tenants.length, detectados: 0, sugeridos: 0, perTenant: [] };
  for (const t of tenants) {
    try {
      const r = await processarTenant(t.tenant_id);
      summary.detectados += r.detectados;
      summary.sugeridos += r.sugeridos;
      summary.perTenant.push(r);
    } catch (err) {
      logger.error('silenciosos.tenant_error', { tenant_id: t.tenant_id, error: err.message });
    }
  }
  logger.info('silenciosos.done', { tenants: summary.tenants, detectados: summary.detectados, sugeridos: summary.sugeridos });
  return summary;
}

module.exports = { runDetectarSilenciosos, faixaDe };
