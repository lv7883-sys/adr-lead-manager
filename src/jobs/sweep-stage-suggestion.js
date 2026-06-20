'use strict';

// ============================================================================
// BACKLOG SWEEP — sugestão de etapa pela IA (SUGGESTION-ONLY, reversível).
//
// Roda o detector (gemini.classifyConversa com as stage_definitions do tenant) sobre os
// leads JÁ existentes do funil e escreve suggested_stage/stage_reasoning onde a IA detecta
// que o lead deveria estar numa etapa à frente (ex.: a Mariana, com experimental agendada,
// parada em "qualificando"). NUNCA move o lead — só preenche a sugestão; a recepção
// confirma/dispensa 1-clique na UI.
//
// Mesmo padrão do batch-classifyconversa: classificação (rede) monta um PLANO em memória,
// a mutação é UMA transação no fim, e um SNAPSHOT é criado ANTES → reversível.
//
//   APPLY=0 -> dry-run (só plano/relatório, NÃO escreve)
//   APPLY=1 -> cria snapshot + aplica o plano numa transação única
//
//   docker exec -e APPLY=0 -i adr-lead-manager node src/jobs/sweep-stage-suggestion.js
//
// TRAVAS (iguais ao fluxo vivo, ver engine.persistStageSuggestion):
//  - só sugere quando is_lead=true e suggested_stage é uma das keys do tenant;
//  - NUNCA sugere a etapa em que o lead já está (kanbanColuna);
//  - respeita dispensa (suggested_stage_dismissed) — não re-sugere o mesmo evento;
//  - preserva decisões humanas: scope exclui review_result/desfecho.
// ============================================================================

const { withTenant } = require('../db');
const gemini = require('../gemini');
const { loadRealHistory } = require('../engine');
const { kanbanColuna } = require('../metrics');

const TENANT = process.env.VALIDA_TENANT || 'ed731a58-62e5-45ad-acba-a5502ff39e92';
const APPLY = process.env.APPLY === '1';
const SNAP = `bkp_stage_sweep_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;

const digits = (s) => String(s || '').replace(/\D/g, '');
const short = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

async function fewShot(t) {
  try {
    const r = await withTenant(t, (c) => c.query(
      `SELECT correct_label, original_reasoning, correction_context, corrected_temperature
         FROM classification_feedback WHERE tenant_id=$1 ORDER BY feedback_at DESC LIMIT 10`, [t]));
    return r.rows.map((x) => ({ label: x.correct_label, reasoning: x.original_reasoning, context: x.correction_context, temperature: x.corrected_temperature }));
  } catch { return []; }
}

async function stageDefs(t) {
  return withTenant(t, (c) => c.query(
    'SELECT stage_definitions FROM tenant_lead_config WHERE tenant_id=$1', [t]
  ).then((r) => r.rows[0]?.stage_definitions || null));
}

async function carregarConversa(lead) {
  const ident = digits(lead.phone || lead.meta_psid);
  const conv = await withTenant(TENANT, (c) => c.query(
    `SELECT id FROM conversations WHERE tenant_id=$1 AND regexp_replace(external_id,'[^0-9]','','g')=$2 ORDER BY updated_at DESC LIMIT 1`,
    [TENANT, ident]).then((r) => r.rows[0]));
  if (!conv) return [];
  return loadRealHistory(TENANT, { conversationId: conv.id, ident, leadId: lead.id });
}

async function classifyRetry(conversation, examples, stage_definitions) {
  let last;
  for (let i = 0; i < 5; i++) {
    try { return await gemini.classifyConversa({ conversation, examples, stageDefinitions: stage_definitions, tenant: TENANT }); }
    catch (e) { last = e; await new Promise((s) => setTimeout(s, 1500 * (i + 1))); }
  }
  throw last;
}

(async () => {
  const defs = await stageDefs(TENANT);
  console.log(`MODO: ${APPLY ? 'APPLY (escreve)' : 'DRY-RUN (não escreve)'} | snapshot=${SNAP}`);
  if (!defs || !Object.keys(defs).length) {
    console.log('Tenant SEM stage_definitions — nada a sugerir. (rode a migration 038 + seed)');
    process.exit(0);
  }
  console.log(`ETAPAS sugeríveis: ${Object.keys(defs).join(', ')}`);
  const examples = await fewShot(TENANT);

  // SCOPE: leads do funil NÃO-terminais, sem decisão humana/desfecho. Terminais
  // (convertido/perdido) e Revisar/Não-classificadas ficam de fora (não estão no kanban
  // de trabalho ou já têm decisão).
  const scope = await withTenant(TENANT, (c) => c.query(
    `SELECT id, name, phone, meta_psid, status, desfecho, suggested_stage, suggested_stage_dismissed
       FROM leads
      WHERE tenant_id=$1 AND review_result IS NULL AND desfecho IS NULL
        AND status IN ('QUALIFYING','QUALIFIED','EXPERIMENTAL_AGENDADA')
      ORDER BY status, name`, [TENANT]).then((r) => r.rows));
  console.log(`SCOPE (tocável): ${scope.length} leads`);

  const plan = [];
  for (const lead of scope) {
    const atual = kanbanColuna(lead.status, lead.desfecho);
    const conversa = await carregarConversa(lead);
    if (!conversa.length) { plan.push({ lead, atual, decisao: 'pula', motivo: 'sem histórico' }); continue; }
    let r;
    try { r = await classifyRetry(conversa, examples, defs); }
    catch (e) { plan.push({ lead, atual, decisao: 'erro', motivo: short(e.message, 60) }); continue; }
    await new Promise((s) => setTimeout(s, 700)); // pacing anti-429
    const sug = r.is_lead ? r.suggested_stage : null;
    if (!sug) { plan.push({ lead, atual, decisao: 'sem-sugestao', motivo: r.is_lead ? 'IA não sugeriu etapa' : 'IA: não é lead' }); continue; }
    if (sug === atual) { plan.push({ lead, atual, decisao: 'ja-na-etapa', sug, motivo: 'já está na etapa sugerida' }); continue; }
    if (sug === lead.suggested_stage_dismissed) { plan.push({ lead, atual, decisao: 'dispensada', sug, motivo: 'etapa já dispensada pela recepção' }); continue; }
    plan.push({ lead, atual, decisao: 'sugere', sug, motivo: short(r.stage_reasoning, 120), stage_reasoning: r.stage_reasoning });
  }

  const sugere = plan.filter((p) => p.decisao === 'sugere');
  const fmt = (p) => `${short(p.lead.name, 22).padEnd(22)} | ${String(p.atual).padEnd(12)}→ ${String(p.sug || '-').padEnd(12)} | ${p.motivo}`;

  console.log(`\n===== SUGESTÕES a gravar (suggestion-only, NÃO move): ${sugere.length} =====`);
  sugere.forEach((p) => console.log('  ' + fmt(p)));
  for (const grp of ['ja-na-etapa', 'dispensada', 'sem-sugestao', 'pula', 'erro']) {
    const arr = plan.filter((p) => p.decisao === grp);
    console.log(`\n----- ${grp}: ${arr.length}`);
    if (grp === 'ja-na-etapa' || grp === 'dispensada' || grp === 'erro') arr.forEach((p) => console.log('  ' + fmt(p)));
  }

  if (!APPLY) { console.log('\nDRY-RUN — nada escrito. Rode com APPLY=1 para aplicar.'); process.exit(0); }
  if (!sugere.length) { console.log('\nNada a sugerir — nenhuma escrita.'); process.exit(0); }

  // SNAPSHOT (reversível): guarda o estado ANTERIOR das 4 colunas de sugestão dos leads
  // afetados. Revert: ver o comentário REVERT abaixo.
  await withTenant(TENANT, async (c) => {
    await c.query(
      `CREATE TABLE IF NOT EXISTS lead_manager.${SNAP} AS
         SELECT id, suggested_stage, stage_reasoning, stage_suggested_at, suggested_stage_dismissed, now() AS snap_at
           FROM lead_manager.leads WHERE 1=0`);
    for (const p of sugere) {
      await c.query(
        `INSERT INTO lead_manager.${SNAP} (id, suggested_stage, stage_reasoning, stage_suggested_at, suggested_stage_dismissed, snap_at)
         SELECT id, suggested_stage, stage_reasoning, stage_suggested_at, suggested_stage_dismissed, now()
           FROM leads WHERE id=$1`, [p.lead.id]);
    }
    // APLICA — só as 3 colunas de sugestão. NUNCA status/desfecho (não move).
    for (const p of sugere) {
      await c.query(
        `UPDATE leads SET suggested_stage=$2, stage_reasoning=$3, stage_suggested_at=now()
          WHERE id=$1 AND review_result IS NULL AND desfecho IS NULL`,
        [p.lead.id, p.sug, p.stage_reasoning || null]);
    }
  });

  console.log(`\nAplicado: ${sugere.length} sugestões | snapshot=lead_manager.${SNAP} | modelo=${gemini.getActiveModel()}`);
  console.log(`REVERT:\n  UPDATE lead_manager.leads l SET suggested_stage=b.suggested_stage, stage_reasoning=b.stage_reasoning, stage_suggested_at=b.stage_suggested_at\n    FROM lead_manager.${SNAP} b WHERE b.id=l.id;\n  DROP TABLE lead_manager.${SNAP};`);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
