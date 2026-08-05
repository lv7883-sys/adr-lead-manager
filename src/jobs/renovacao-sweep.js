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

module.exports = { runRenovacaoSweep, processarTenant, renovacaoPrevisao, loadRenovacaoConfig };

if (require.main === module) {
  runRenovacaoSweep().then(() => process.exit(0)).catch((e) => { logger.error('renovacao.fatal', { error: e.message }); process.exit(1); });
}
