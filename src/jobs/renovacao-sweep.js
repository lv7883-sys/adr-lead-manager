'use strict';
//
// renovacao-sweep.js — Renovação Fase 1 ("modo avisa"). Job diário que substitui a régua "D-45".
//
// Para cada tenant ATIVO com renovacao_habilitada, varre os contratos VIGENTES (service_account) e,
// quando faltam exatamente 10 ou 2 dias CORRIDOS para o fim (fim_vigencia - hoje IN {10,2}), resolve
// o RESPONSÁVEL pelo contrato (pagador; senão o próprio aluno) + telefone (contact_point), pede um
// RASCUNHO à Janis (gemini.sugestaoRenovacao) e grava um touchpoint com status='pendente' — que a
// recepção vê e usa. Idempotente por UNIQUE (tenant, account, marco, fim_vigencia): não regenera nem
// gasta IA quando o toque já existe.
//
// Fase 2 (pendente): quando renovacao_auto_envio=ON, disparar o rascunho automaticamente (reusando
// o caminho de envio do autoReply: outbound.credsForTenant + evolution.sendText, com throttle).
//
// Âncora = fim_vigencia (fim ADMINISTRATIVO do contrato), não "última aula" real. A mensagem fala em
// "o contrato encerra em <data>" — nunca em "última aula em N dias" (poderia ficar errado).
//
const { pool, withTenant } = require('../db');
const geminiDefault = require('../gemini');
const logger = require('../logger');

const MARCO_DE = { 10: 'D-10', 2: 'D-2' };
// Fase 2 — trava anti-ban do envio AUTOMÁTICO (conservador por padrão; ajustável por env).
const AUTO_CAP_DIA = Number(process.env.RENOVACAO_AUTO_CAP_DIA || 40);        // teto de auto-envios/dia/tenant
const AUTO_THROTTLE_MS = Number(process.env.RENOVACAO_AUTO_THROTTLE_MS || 4000); // respiro entre envios

// Config de renovação + contexto da Janis do tenant. Sem linha em automacao_config → defaults
// (habilitada=true, auto=false). school_name (tenant_lead_config) é fallback de contexto.
async function loadRenovacaoConfig(c, tenantId) {
  const ac = (await c.query(
    `SELECT nome_ia, contexto_ia, renovacao_habilitada, renovacao_auto_envio
       FROM lead_manager.automacao_config WHERE tenant_id = $1`, [tenantId])).rows[0] || {};
  const lc = (await c.query(
    `SELECT school_name FROM tenant_lead_config WHERE tenant_id = $1`, [tenantId])).rows[0] || {};
  return {
    habilitada: ac.renovacao_habilitada !== false,       // default true
    autoEnvio: ac.renovacao_auto_envio === true,          // default false (Fase 2)
    nomeIa: ac.nome_ia || null,
    schoolContext: ac.contexto_ia || lc.school_name || null,
  };
}

// Contratos que caem em D-10 / D-2 hoje e AINDA não têm touchpoint desse marco/âncora, já com
// destinatário (pagador → senão beneficiário) e telefone resolvidos.
async function contratosNoMarco(c, tenantId) {
  return (await c.query(
    `WITH alvo AS (
       SELECT sa.id AS account_id, sa.fim_vigencia, sa.servico_label,
              (sa.fim_vigencia - current_date)::int AS dias
         FROM lead_manager.service_account sa
        WHERE sa.tenant_id = $1
          AND sa.fonte_ausente_em IS NULL
          AND sa.status IS DISTINCT FROM 'cancelado'
          AND (sa.fim_vigencia - current_date) IN (10, 2)
     ),
     aluno AS (
       SELECT am.account_id, min(p.display_name) AS aluno_nome
         FROM lead_manager.account_member am
         JOIN lead_manager.person p ON p.id = am.person_id
        WHERE am.tenant_id = $1 AND am.bond = 'beneficiario'
        GROUP BY am.account_id
     ),
     resp AS (
       SELECT DISTINCT ON (am.account_id)
              am.account_id, am.person_id, am.bond,
              p.display_name AS nome, cp.value_raw AS phone
         FROM lead_manager.account_member am
         JOIN lead_manager.person p ON p.id = am.person_id
         JOIN lead_manager.contact_point cp
           ON cp.person_id = am.person_id AND cp.kind = 'phone' AND cp.tenant_id = $1
        WHERE am.tenant_id = $1 AND am.bond IN ('pagador','beneficiario')
        ORDER BY am.account_id,
                 CASE am.bond WHEN 'pagador' THEN 0 ELSE 1 END,   -- pagador primeiro
                 cp.confidence DESC,                              -- 'provado' > 'alegado'
                 cp.created_at
     )
     SELECT a.account_id, a.fim_vigencia, to_char(a.fim_vigencia,'YYYY-MM-DD') AS fim_iso,
            a.dias, a.servico_label,
            r.person_id, r.nome AS destinatario_nome, r.bond, r.phone,
            al.aluno_nome
       FROM alvo a
       JOIN resp r ON r.account_id = a.account_id
       LEFT JOIN aluno al ON al.account_id = a.account_id
      WHERE NOT EXISTS (
              SELECT 1 FROM lead_manager.renovacao_touchpoint rt
               WHERE rt.tenant_id = $1 AND rt.account_id = a.account_id
                 AND rt.fim_vigencia = a.fim_vigencia
                 AND rt.marco = (CASE WHEN a.dias = 2 THEN 'D-2' ELSE 'D-10' END)
            )
        -- Contato INTERNO (equipe/dono) nunca recebe toque de renovação, mesmo com contrato próprio.
        AND NOT EXISTS (
              SELECT 1 FROM lead_manager.internal_contacts ic
               WHERE ic.tenant_id = $1
                 AND lead_manager.br_phone_key(ic.phone) = lead_manager.br_phone_key(r.phone)
            )`,
    [tenantId]
  )).rows;
}

// Contratos SEM destinatário/telefone resolvível nos marcos (só p/ log — não enfileira).
async function semDestinatario(c, tenantId) {
  return (await c.query(
    `SELECT count(*)::int AS n
       FROM lead_manager.service_account sa
      WHERE sa.tenant_id = $1 AND sa.fonte_ausente_em IS NULL
        AND sa.status IS DISTINCT FROM 'cancelado'
        AND (sa.fim_vigencia - current_date) IN (10, 2)
        AND NOT EXISTS (
              SELECT 1 FROM lead_manager.account_member am
               JOIN lead_manager.contact_point cp
                 ON cp.person_id = am.person_id AND cp.kind = 'phone' AND cp.tenant_id = $1
              WHERE am.account_id = sa.id AND am.bond IN ('pagador','beneficiario')
            )`, [tenantId])).rows[0].n;
}

async function processarTenant(tenantId, deps = {}) {
  const gemini = deps.gemini || geminiDefault;
  const resumo = { tenant_id: tenantId, marcos: 0, enfileirados: 0, sem_telefone: 0, 'D-10': 0, 'D-2': 0 };

  const cfg = await withTenant(tenantId, (c) => loadRenovacaoConfig(c, tenantId));
  if (!cfg.habilitada) { resumo.skipped = 'desabilitada'; return resumo; }

  const alvos = await withTenant(tenantId, (c) => contratosNoMarco(c, tenantId));
  resumo.marcos = alvos.length;
  resumo.sem_telefone = await withTenant(tenantId, (c) => semDestinatario(c, tenantId));
  if (!alvos.length) return resumo;

  for (const a of alvos) {
    const marco = MARCO_DE[a.dias];
    if (!marco) continue;
    try {
      const sug = await gemini.sugestaoRenovacao({
        marco,
        alunoNome: a.aluno_nome || a.destinatario_nome,
        responsavelNome: a.bond === 'pagador' ? a.destinatario_nome : null,
        servico: a.servico_label,
        dataFimISO: a.fim_iso,
        schoolContext: cfg.schoolContext,
        nomeIa: cfg.nomeIa,
      });
      if (!sug || !sug.rascunho) {
        logger.warn('renovacao.sem_rascunho', { tenant_id: tenantId, account_id: a.account_id, marco });
        continue;
      }
      const ins = await withTenant(tenantId, (c) => c.query(
        `INSERT INTO lead_manager.renovacao_touchpoint
           (tenant_id, account_id, person_id, marco, fim_vigencia, due_date, phone,
            destinatario_nome, aluno_nome, servico_label, estrategia, rascunho, status)
         VALUES ($1,$2,$3,$4,$5,current_date,$6,$7,$8,$9,$10,$11,'pendente')
         ON CONFLICT (tenant_id, account_id, marco, fim_vigencia) DO NOTHING`,
        [tenantId, a.account_id, a.person_id, marco, a.fim_vigencia, a.phone,
         a.destinatario_nome || null, a.aluno_nome || null, a.servico_label || null,
         sug.estrategia || null, sug.rascunho]));
      if (ins.rowCount > 0) { resumo.enfileirados += 1; resumo[marco] += 1; }
    } catch (err) {
      logger.error('renovacao.alvo_error', { tenant_id: tenantId, account_id: a.account_id, marco, error: err.message });
    }
  }
  return resumo;
}

// PREVISÃO (tudo que vem ANTES de D-10) — indicador para recepção/gestores. NÃO envia nada.
async function renovacaoPrevisao(tenantId, { horizonteDias = 45 } = {}) {
  return withTenant(tenantId, async (c) => {
    const contratos = (await c.query(
      `SELECT sa.id AS account_id, sa.servico_label, sa.fim_vigencia, sa.status_renovacao,
              (sa.fim_vigencia - current_date)::int AS dias,
              (SELECT min(p.display_name) FROM lead_manager.account_member am
                 JOIN lead_manager.person p ON p.id = am.person_id
                WHERE am.account_id = sa.id AND am.bond = 'beneficiario') AS aluno_nome
         FROM lead_manager.service_account sa
        WHERE sa.tenant_id = $1 AND sa.fonte_ausente_em IS NULL
          AND sa.status IS DISTINCT FROM 'cancelado'
          AND sa.fim_vigencia >= current_date
          AND sa.fim_vigencia <= current_date + ($2 || ' days')::interval
        ORDER BY sa.fim_vigencia`, [tenantId, String(horizonteDias)])).rows;
    const buckets = { 'D-2': 0, 'D-10': 0, '11-20d': 0, '21-30d': 0, '31d+': 0 };
    for (const r of contratos) {
      if (r.dias <= 2) buckets['D-2'] += 1;
      else if (r.dias <= 10) buckets['D-10'] += 1;
      else if (r.dias <= 20) buckets['11-20d'] += 1;
      else if (r.dias <= 30) buckets['21-30d'] += 1;
      else buckets['31d+'] += 1;
    }
    return { horizonteDias, total: contratos.length, buckets, contratos };
  });
}

// Ciclo em todos os tenants ativos. deps injetáveis p/ teste (pool, gemini).
async function runRenovacaoSweep(deps = {}) {
  const q = deps.pool || pool;
  const tenants = (await q.query('SELECT tenant_id FROM tenants_active()')).rows;
  const summary = { tenants: tenants.length, marcos: 0, enfileirados: 0, perTenant: [] };
  for (const t of tenants) {
    try {
      const r = await processarTenant(t.tenant_id, deps);
      summary.marcos += r.marcos || 0;
      summary.enfileirados += r.enfileirados || 0;
      summary.perTenant.push(r);
    } catch (err) {
      logger.error('renovacao.tenant_error', { tenant_id: t.tenant_id, error: err.message });
    }
  }
  logger.info('renovacao.done', { tenants: summary.tenants, marcos: summary.marcos, enfileirados: summary.enfileirados });
  return summary;
}

// ============================================================================
// FASE 2 — ENVIO AUTOMÁTICO (gated pelo toggle renovacao_auto_envio, DESLIGADO por padrão).
// Roda num horário comercial (cron 10h) e dispara os toques pendentes de quem LIGOU o automático,
// reusando o MESMO caminho de envio do inbox (ensureConversation + sendMessage → cria a conversa se
// precisar e persiste na timeline). Trava anti-ban: teto diário + throttle. NÃO usa o Scheduler (D2):
// o volume da renovação é baixo — o Scheduler é p/ campanha em massa de verdade.
// ============================================================================

// Envia UM toque (cria/encontra a conversa e manda). Injetável no teste via deps.send.
// require LAZY do inbox: só carrega o módulo (pesado) quando de fato há auto-envio.
async function _autoSendOne(tenantId, tp) {
  const { ensureConversation, sendMessage } = require('../routes/inbox');
  const conv = await withTenant(tenantId, (c) => ensureConversation(c, tenantId, tp.phone));
  if (!conv) return { ok: false, reason: 'telefone_invalido' };
  return sendMessage(tenantId, conv.conversation_id, { text: tp.rascunho, sender: 'renovacao-auto' });
}

async function autoEnviarTenant(tenantId, deps = {}) {
  const send = deps.send || _autoSendOne;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const cap = deps.capDia != null ? deps.capDia : AUTO_CAP_DIA;
  const throttle = deps.throttleMs != null ? deps.throttleMs : AUTO_THROTTLE_MS;

  const cfg = await withTenant(tenantId, (c) => loadRenovacaoConfig(c, tenantId));
  if (!cfg.habilitada || !cfg.autoEnvio) return { tenant_id: tenantId, skipped: !cfg.autoEnvio ? 'auto_off' : 'desabilitada' };

  const jaHoje = await withTenant(tenantId, async (c) => (await c.query(
    `SELECT count(*)::int AS n FROM lead_manager.renovacao_touchpoint
      WHERE tenant_id=$1 AND auto=true AND enviado_em::date = current_date`, [tenantId])).rows[0].n);
  const restante = Math.max(0, cap - jaHoje);
  if (restante <= 0) return { tenant_id: tenantId, enviados: 0, cap_atingido: true };

  const pend = await withTenant(tenantId, async (c) => (await c.query(
    `SELECT id, phone, rascunho FROM lead_manager.renovacao_touchpoint
      WHERE tenant_id=$1 AND status='pendente' AND coalesce(phone,'')<>''
      ORDER BY (marco='D-2') DESC, fim_vigencia ASC
      LIMIT $2`, [tenantId, restante])).rows);

  const resumo = { tenant_id: tenantId, elegiveis: pend.length, enviados: 0, falhas: 0 };
  for (let i = 0; i < pend.length; i++) {
    const tp = pend[i];
    try {
      const r = await send(tenantId, tp);
      if (r && r.ok) {
        await withTenant(tenantId, (c) => c.query(
          `UPDATE lead_manager.renovacao_touchpoint
              SET status='enviado', auto=true, enviado_em=now(), updated_at=now()
            WHERE id=$1 AND status='pendente'`, [tp.id]));
        resumo.enviados += 1;
      } else {
        resumo.falhas += 1;
        logger.warn('renovacao.auto.falha', { tenant_id: tenantId, touchpoint: tp.id, reason: r && r.reason });
      }
    } catch (err) {
      resumo.falhas += 1;
      logger.error('renovacao.auto.erro', { tenant_id: tenantId, touchpoint: tp.id, error: err.message });
    }
    if (throttle && i < pend.length - 1) await sleep(throttle);
  }
  return resumo;
}

// Ciclo de auto-envio em todos os tenants ativos. deps injetáveis p/ teste (pool, send, sleep, capDia, throttleMs).
async function runRenovacaoAutoEnvio(deps = {}) {
  const q = deps.pool || pool;
  const tenants = (await q.query('SELECT tenant_id FROM tenants_active()')).rows;
  const summary = { tenants: tenants.length, enviados: 0, falhas: 0, perTenant: [] };
  for (const t of tenants) {
    try {
      const r = await autoEnviarTenant(t.tenant_id, deps);
      summary.enviados += r.enviados || 0;
      summary.falhas += r.falhas || 0;
      summary.perTenant.push(r);
    } catch (err) {
      logger.error('renovacao.auto.tenant_error', { tenant_id: t.tenant_id, error: err.message });
    }
  }
  logger.info('renovacao.auto.done', { tenants: summary.tenants, enviados: summary.enviados, falhas: summary.falhas });
  return summary;
}

module.exports = { runRenovacaoSweep, processarTenant, renovacaoPrevisao, loadRenovacaoConfig, runRenovacaoAutoEnvio, autoEnviarTenant };

if (require.main === module) {
  const fn = process.argv.includes('--auto') ? runRenovacaoAutoEnvio : runRenovacaoSweep;
  fn().then(() => process.exit(0)).catch((e) => { logger.error('renovacao.fatal', { error: e.message }); process.exit(1); });
}
