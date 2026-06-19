'use strict';

// ============================================================================
// BATCH — aplica gemini.classifyConversa no backlog e roteia pros 3 tiers.
//   funil (≥0.85) | Revisar/review_queue (0.40–0.84) | Não-classificadas (<0.40)
//
// Padrão: classificação (rede, lenta, com retry/backoff) roda FORA de transação e
// monta um PLANO em memória; a mutação é UMA transação atômica no fim. Snapshot
// (bkp_batch_classifyconversa_20260619) é criado ANTES → reversível.
//
//   APPLY=0 -> dry-run (só plano/relatório, NÃO escreve)
//   APPLY=1 -> aplica o plano numa transação única
//   PROF_DIGITS / STAFF_DIGITS -> CSV de dígitos (professores / staff) injetados
//
//   docker exec -e APPLY=0 -e PROF_DIGITS=... -e STAFF_DIGITS=... \
//     -i adr-lead-manager node src/jobs/batch-classifyconversa.js
//
// GUARDRAILS:
//  - Gate de STAFF (internal_contacts) ANTES do classificador → NOT_LEAD direto.
//  - Professores (app.professor_notificacao): por oscilação, NUNCA auto-promove
//    pro funil; se classificador der "funil", REBAIXA pra Revisar (confirmação humana).
//  - Preserva decisões humanas/desfecho: o scope já EXCLUI review_result/desfecho.
//  - NUNCA deleta. O que sai do funil vira reviewável (review_queue=true).
//  - Classificação que falhar (após retries) → 'inalterado' (não move sem sinal).
// ============================================================================

const { withTenant } = require('../db');
const gemini = require('../gemini');
const { loadRealHistory } = require('../engine');

const TENANT = process.env.VALIDA_TENANT || 'ed731a58-62e5-45ad-acba-a5502ff39e92';
const APPLY = process.env.APPLY === '1';
const PROF = new Set((process.env.PROF_DIGITS || '').split(',').map((s) => s.trim()).filter(Boolean));
const STAFF = new Set((process.env.STAFF_DIGITS || '').split(',').map((s) => s.trim()).filter(Boolean));

const AUTO = 0.85;   // ≥ → funil
const REVIEW = 0.40; // ≥ → Revisar ; < → Não-classificadas
const digits = (s) => String(s || '').replace(/\D/g, '');
const inFunil = (st) => st !== 'NOT_LEAD' && st !== 'REVIEW_QUEUE';

async function fewShot(t) {
  try {
    const r = await withTenant(t, (c) => c.query(
      `SELECT correct_label, original_reasoning, correction_context, corrected_temperature
         FROM classification_feedback WHERE tenant_id=$1 ORDER BY feedback_at DESC LIMIT 10`, [t]));
    return r.rows.map((x) => ({ label: x.correct_label, reasoning: x.original_reasoning, context: x.correction_context, temperature: x.corrected_temperature }));
  } catch { return []; }
}

async function carregarConversa(lead) {
  const ident = digits(lead.phone || lead.meta_psid);
  const conv = await withTenant(TENANT, (c) => c.query(
    `SELECT id FROM conversations WHERE tenant_id=$1 AND regexp_replace(external_id,'[^0-9]','','g')=$2 ORDER BY updated_at DESC LIMIT 1`,
    [TENANT, ident]).then((r) => r.rows[0]));
  if (!conv) return [];
  return loadRealHistory(TENANT, { conversationId: conv.id, ident, leadId: lead.id });
}

async function classifyRetry(conversation, examples) {
  let last;
  for (let i = 0; i < 5; i++) {
    try { return await gemini.classifyConversa({ conversation, examples, tenant: TENANT }); }
    catch (e) { last = e; await new Promise((s) => setTimeout(s, 1500 * (i + 1))); }
  }
  throw last;
}

const short = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

async function tierCounts() {
  return withTenant(TENANT, (c) => c.query(
    `SELECT
       count(*) FILTER (WHERE status NOT IN ('NOT_LEAD','REVIEW_QUEUE')) AS funil,
       count(*) FILTER (WHERE status='REVIEW_QUEUE' AND review_queue AND review_result IS NULL) AS revisar,
       count(*) FILTER (WHERE status='NOT_LEAD') AS nao_classificadas
     FROM leads WHERE tenant_id=$1`, [TENANT]).then((r) => r.rows[0]));
}

(async () => {
  const examples = await fewShot(TENANT);
  console.log(`MODO: ${APPLY ? 'APPLY (escreve)' : 'DRY-RUN (não escreve)'} | profs=${PROF.size} staff=${STAFF.size}`);

  // SCOPE: leads "limpos" — exclui decisões humanas (review_result) e desfecho.
  const scope = await withTenant(TENANT, (c) => c.query(
    `SELECT id,name,phone,meta_psid,status, round(classification_confidence,2) old_conf
       FROM leads
      WHERE tenant_id=$1 AND review_result IS NULL AND desfecho IS NULL
        AND status IN ('QUALIFYING','QUALIFIED','NOT_LEAD','REVIEW_QUEUE')
      ORDER BY status, name`, [TENANT]).then((r) => r.rows));
  console.log(`SCOPE (tocável): ${scope.length} leads`);

  const before = await tierCounts();

  const plan = [];
  for (const lead of scope) {
    const d = digits(lead.phone || lead.meta_psid);
    const cur = lead.status;
    const isStaff = STAFF.has(d);
    const isProf = PROF.has(d);
    let tier, score = null, intent = null, reasoning = null, prof_clamp = false, note = '';

    if (isStaff) {
      // GATE STAFF — antes do classificador.
      tier = 'nao_classificadas'; reasoning = 'staff (internal_contacts) — não-lead por definição';
      intent = 'INTERNO'; score = 0; note = 'staff_gate';
    } else {
      const conversa = await carregarConversa(lead);
      if (!conversa.length) { plan.push({ lead, cur, tier: 'inalterado', score: null, intent: null, reasoning: 'sem histórico (sem sinal)', prof_clamp: false, note: 'sem_historico' }); continue; }
      let r;
      try { r = await classifyRetry(conversa, examples); }
      catch (e) { plan.push({ lead, cur, tier: 'inalterado', score: null, intent: null, reasoning: 'ERRO classificador: ' + short(e.message, 60), prof_clamp: false, note: 'erro' }); continue; }
      score = r.confidence; intent = r.intent; reasoning = r.reasoning;
      // ROTEAMENTO por is_lead + intent — NÃO por confidence. (Achado do dry-run:
      // o `confidence` do modelo é a CERTEZA da decisão, não P(lead): not-leads
      // confiantes vêm com conf alta (ex.: is_lead=false, conf=0.9) e oscila entre
      // execuções no temp 0. `is_lead` é estável e bate com o reasoning.)
      let base;
      if (r.is_lead === true && intent === 'NOVA_OPORTUNIDADE') base = 'funil';
      else if (r.is_lead === false && (intent === 'ROTINA_CLIENTE' || intent === 'INTERNO')) base = 'nao_classificadas';
      else base = 'revisar'; // INDEFINIDO ou is_lead/intent em conflito → confirmação humana
      if (isProf && base === 'funil') { base = 'revisar'; prof_clamp = true; note = 'prof_clamp'; }
      tier = base;
      await new Promise((s) => setTimeout(s, 700)); // pacing anti-429
    }

    // status/review_queue alvo por tier (sem REBAIXAR estágio de quem já está no funil).
    // SAÍDA DO FUNIL → Revisar: quem ESTÁ no funil e vira não-lead NÃO cai direto pra
    // NOT_LEAD — vai pra REVIEW_QUEUE pra a recepção confirmar antes de sair de vez
    // (protege contra a oscilação do classificador em casos borderline).
    let newStatus, newRq, exit_funil = false;
    if (tier === 'funil') { newStatus = inFunil(cur) ? cur : 'QUALIFYING'; newRq = false; }
    else if (tier === 'revisar') { newStatus = 'REVIEW_QUEUE'; newRq = true; }
    else { // nao_classificadas
      if (inFunil(cur)) { newStatus = 'REVIEW_QUEUE'; newRq = true; exit_funil = true; }
      else { newStatus = 'NOT_LEAD'; newRq = true; }
    }
    plan.push({ lead, cur, tier, newStatus, newRq, score, intent, reasoning, prof_clamp, note, exit_funil });
  }

  // Movimentos (por status REALIZADO).
  const moved = plan.filter((p) => p.tier !== 'inalterado');
  const saiu = moved.filter((p) => inFunil(p.cur) && !inFunil(p.newStatus));        // saem do funil (→ Revisar)
  const recuperado = moved.filter((p) => !inFunil(p.cur) && inFunil(p.newStatus));  // leads reais recuperados
  const pravisar = moved.filter((p) => p.newStatus === 'REVIEW_QUEUE');             // tudo que cai em Revisar
  const naoclass = moved.filter((p) => p.newStatus === 'NOT_LEAD');                 // confirmados fora do funil
  const inalterado = plan.filter((p) => p.tier === 'inalterado');

  const fmt = (p) => `${short(p.lead.name, 22).padEnd(22)} | ${p.cur.padEnd(11)}→${String(p.newStatus).padEnd(11)} | conf=${p.score == null ? '-' : p.score.toFixed(2)} | ${p.intent || '-'}${p.prof_clamp ? ' [PROF→revisar]' : ''} | ${short(p.reasoning, 90)}`;

  console.log('\n================= ANTES (tenant) =================');
  console.log(`funil=${before.funil}  revisar=${before.revisar}  nao_classificadas=${before.nao_classificadas}`);

  console.log(`\n===== SAÍDA DO FUNIL → Revisar (falsos a confirmar): ${saiu.length} =====`);
  saiu.forEach((p) => console.log('  ' + fmt(p)));
  console.log(`\n===== RECUPERADO PRO FUNIL (leads reais descartados): ${recuperado.length} =====`);
  recuperado.forEach((p) => console.log('  ' + fmt(p)));
  console.log(`\n===== TOTAL em Revisar (review_queue): ${pravisar.length}  [saída-funil=${saiu.length} + indefinido=${pravisar.length - saiu.length}] =====`);
  console.log(`\n===== NOT_LEAD confirmados (já fora do funil): ${naoclass.length} =====`);
  console.log(`\n===== INALTERADO (sem histórico / erro): ${inalterado.length} =====`);
  inalterado.forEach((p) => console.log(`  ${short(p.lead.name, 22).padEnd(22)} | ${p.cur} | ${p.reasoning}`));

  console.log(`\n===== PLANO realizado (scope): funil=${moved.filter((p) => inFunil(p.newStatus)).length}  revisar=${pravisar.length}  not_lead=${naoclass.length}  inalterado=${inalterado.length} =====`);

  if (!APPLY) { console.log('\nDRY-RUN — nada escrito. Rode com APPLY=1 para aplicar.'); process.exit(0); }

  // ---- APLICA tudo numa ÚNICA transação ----
  const writes = plan.filter((p) => p.tier !== 'inalterado');
  await withTenant(TENANT, async (c) => {
    for (const p of writes) {
      await c.query(
        `UPDATE leads SET status=$2, review_queue=$3,
                classification_confidence=$4,
                classification_reasoning=$5,
                classification_signals=$6,
                updated_at=now()
          WHERE id=$1 AND review_result IS NULL AND desfecho IS NULL`,
        [p.lead.id, p.newStatus, p.newRq,
         p.score, `[batch-conversa] ${short(p.reasoning, 240)}`,
         JSON.stringify({ intent: p.intent, tier: p.tier, prof_clamp: p.prof_clamp, exit_funil: p.exit_funil, batch: '20260619' })]
      );
    }
  });
  const after = await tierCounts();
  console.log('\n================= DEPOIS (tenant) =================');
  console.log(`funil=${after.funil}  revisar=${after.revisar}  nao_classificadas=${after.nao_classificadas}`);
  console.log(`Δ funil=${after.funil - before.funil}  revisar=${after.revisar - before.revisar}  nao_classificadas=${after.nao_classificadas - before.nao_classificadas}`);
  console.log(`Aplicados: ${writes.length} updates | modelo=${gemini.getActiveModel()}`);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
