'use strict';

// ============================================================================
// BACKFILL do conversation_state (FASE 4) — roda o detector de ESTADO da IA sobre
// os leads existentes e grava SÓ os campos de estado (conversation_state /
// state_reasoning / state_computed_at). NÃO mexe em status, funil, feedback nem nada.
//
//   APPLY=0 → dry-run (só relatório)   |   APPLY=1 → grava (numa transação)
//   docker exec -e APPLY=1 -i adr-lead-manager node src/jobs/backfill-conversation-state.js
//
// Reversível: snapshot bkp_conversation_state_20260620 (id + colunas de estado).
// ============================================================================

const { withTenant } = require('../db');
const gemini = require('../gemini');
const { loadRealHistory } = require('../engine');

const TENANT = process.env.VALIDA_TENANT || 'ed731a58-62e5-45ad-acba-a5502ff39e92';
const APPLY = process.env.APPLY === '1';

async function fewShot(t) {
  try {
    const r = await withTenant(t, (c) => c.query(
      `SELECT correct_label, original_reasoning, correction_context, corrected_temperature
         FROM classification_feedback WHERE tenant_id=$1 ORDER BY feedback_at DESC LIMIT 10`, [t]));
    return r.rows.map((x) => ({ label: x.correct_label, reasoning: x.original_reasoning, context: x.correction_context, temperature: x.corrected_temperature }));
  } catch { return []; }
}
async function carregarConversa(lead) {
  const ident = String(lead.phone || lead.meta_psid || '').replace(/\D/g, '');
  const conv = await withTenant(TENANT, (c) => c.query(
    `SELECT id FROM conversations WHERE tenant_id=$1 AND regexp_replace(external_id,'[^0-9]','','g')=$2 ORDER BY updated_at DESC LIMIT 1`,
    [TENANT, ident]).then((r) => r.rows[0]));
  if (!conv) return [];
  return loadRealHistory(TENANT, { conversationId: conv.id, ident, leadId: lead.id });
}
async function classifyRetry(conversation, examples) {
  let last;
  for (let i = 0; i < 4; i += 1) {
    try { return await gemini.classifyConversa({ conversation, examples, tenant: TENANT }); }
    catch (e) { last = e; await new Promise((s) => setTimeout(s, 1200 * (i + 1))); }
  }
  throw last;
}
const short = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

(async () => {
  const examples = await fewShot(TENANT);
  console.log(`MODO: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  const scope = await withTenant(TENANT, (c) => c.query(
    `SELECT id, name, phone, meta_psid, status FROM leads
      WHERE tenant_id=$1 AND desfecho IS NULL
        AND status IN ('QUALIFYING','QUALIFIED','NOT_LEAD','REVIEW_QUEUE')
      ORDER BY status, name`, [TENANT]).then((r) => r.rows));
  console.log(`SCOPE: ${scope.length} leads`);

  const plan = [];
  for (const lead of scope) {
    const conversa = await carregarConversa(lead);
    if (!conversa.length) { plan.push({ lead, state: null, note: 'sem histórico' }); continue; }
    let r;
    try { r = await classifyRetry(conversa, examples); }
    catch (e) { plan.push({ lead, state: null, note: 'erro: ' + short(e.message, 40) }); continue; }
    plan.push({ lead, state: r.conversation_state, state_reasoning: r.state_reasoning, intent: r.intent });
    await new Promise((s) => setTimeout(s, 700)); // pacing anti-429
  }

  const byState = {};
  for (const p of plan) byState[p.state || '(sem)'] = (byState[p.state || '(sem)'] || 0) + 1;
  console.log('\n=== ESTADOS (plano) ===');
  console.log(JSON.stringify(byState, null, 0));

  // Casos-chave pra validação.
  for (const nm of ['mariana', 'guilherme inui']) {
    const p = plan.find((x) => new RegExp(nm, 'i').test(x.lead.name));
    if (p) console.log(`VALIDA ${p.lead.name}: state=${p.state} | ${short(p.state_reasoning, 80)}`);
  }

  if (!APPLY) { console.log('\nDRY-RUN — nada gravado.'); process.exit(0); }

  const writes = plan.filter((p) => p.state);
  await withTenant(TENANT, async (c) => {
    for (const p of writes) {
      await c.query(
        `UPDATE leads SET conversation_state=$2, state_reasoning=$3, state_computed_at=now() WHERE id=$1`,
        [p.lead.id, p.state, p.state_reasoning || null]
      );
    }
  });
  console.log(`\nGRAVADOS: ${writes.length} leads | modelo=${gemini.getActiveModel()}`);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
