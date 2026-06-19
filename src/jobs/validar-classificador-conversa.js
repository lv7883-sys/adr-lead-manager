'use strict';

// ============================================================================
// VALIDAÇÃO do classificador CONTEXT-AWARE (gemini.classifyConversa).
// SOMENTE leitura + chamada à IA. NÃO altera banco, NÃO governa funil, sem batch.
//
//   docker exec -i adr-lead-manager node src/jobs/validar-classificador-conversa.js
//
// Monta a conversa INTEIRA de cada lead (lead + recepção, cronológica) via a mesma
// loadRealHistory do funil e roda classifyConversa. Imprime uma TABELA comparando o
// is_lead ATUAL do sistema (derivado do status/desfecho) com o do classificador novo.
// ============================================================================

const { withTenant } = require('../db');
const gemini = require('../gemini');
const { loadRealHistory } = require('../engine');

const TENANT = process.env.VALIDA_TENANT || 'ed731a58-62e5-45ad-acba-a5502ff39e92'; // ADR Valinhos

// is_lead "atual no sistema": como o funil HOJE trata o lead.
//   QUALIFYING/QUALIFIED  -> está no funil como lead (true)
//   desfecho=matriculado  -> lead convertido (true)
//   NOT_LEAD              -> não-lead (false)
function isLeadAtual(status, desfecho) {
  if (desfecho === 'matriculado') return true;
  if (status === 'NOT_LEAD') return false;
  if (status === 'QUALIFYING' || status === 'QUALIFIED') return true;
  return null;
}

// Few-shot dinâmico — o MESMO que o Portão 1 real usa (correções da recepção).
async function fewShot(tenantId) {
  try {
    const r = await withTenant(tenantId, (c) => c.query(
      `SELECT correct_label, original_reasoning, correction_context, corrected_temperature
         FROM classification_feedback WHERE tenant_id = $1
        ORDER BY feedback_at DESC LIMIT 10`, [tenantId]));
    return r.rows.map((x) => ({
      label: x.correct_label, reasoning: x.original_reasoning,
      context: x.correction_context, temperature: x.corrected_temperature,
    }));
  } catch { return []; }
}

// Conversa de um lead pelo telefone/psid: acha a conversation e delega à loadRealHistory.
async function carregarConversa(tenantId, lead) {
  const ident = String(lead.phone || lead.meta_psid || '').replace(/\D/g, '');
  const conv = await withTenant(tenantId, (c) => c.query(
    `SELECT id FROM conversations
       WHERE tenant_id = $1 AND regexp_replace(external_id, '[^0-9]', '', 'g') = $2
       ORDER BY updated_at DESC LIMIT 1`, [tenantId, ident]).then((r) => r.rows[0]));
  if (!conv) return [];
  return loadRealHistory(tenantId, { conversationId: conv.id, ident, leadId: lead.id });
}

async function cohort(tenantId, label, sql) {
  const rows = await withTenant(tenantId, (c) => c.query(sql, [tenantId]).then((r) => r.rows));
  return rows.map((r) => ({ ...r, cohort: label }));
}

function short(s, n) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
}

(async () => {
  const examples = await fewShot(TENANT);

  // -- COORTES (item 3 do brief) --
  const fp = await cohort(TENANT, 'FALSO-POSITIVO',
    `SELECT id,name,phone,meta_psid,status,desfecho FROM leads
      WHERE tenant_id=$1 AND name ~* 'matuki|miranda|crespi|bonini' ORDER BY name`);

  const conv = await cohort(TENANT, 'CONVERTIDO/QUALIF',
    `SELECT id,name,phone,meta_psid,status,desfecho FROM leads
      WHERE tenant_id=$1 AND (desfecho='matriculado' OR status='QUALIFIED') ORDER BY status`);

  // NOT_LEAD com conteúdo de conversa real (>=1 msg do lead) — pra ver se RECUPERA algum.
  const notlead = await cohort(TENANT, 'NOT_LEAD',
    `SELECT l.id,l.name,l.phone,l.meta_psid,l.status,l.desfecho FROM leads l
      WHERE l.tenant_id=$1 AND l.status='NOT_LEAD'
        AND EXISTS (SELECT 1 FROM conversations c JOIN messages m ON m.conversation_id=c.id
                    WHERE regexp_replace(c.external_id,'[^0-9]','','g')=regexp_replace(coalesce(l.phone,l.meta_psid,''),'[^0-9]','','g')
                      AND m.role='USER')
      ORDER BY l.updated_at DESC LIMIT 8`);

  const todos = [...fp, ...conv, ...notlead];
  const linhas = [];

  for (const lead of todos) {
    const conversa = await carregarConversa(TENANT, lead);
    // Retry com backoff: o flash free-tier dá 429/fetch error em rajada — transitório.
    let r = { is_lead: null, confidence: null, reasoning: 'ERRO', intent: null };
    for (let i = 0; i < 5; i++) {
      try { r = await gemini.classifyConversa({ conversation: conversa, examples, tenant: TENANT }); break; }
      catch (e) { r.reasoning = 'ERRO: ' + e.message; await new Promise((s) => setTimeout(s, 1500 * (i + 1))); }
    }
    await new Promise((s) => setTimeout(s, 800)); // pacing entre leads
    const atual = isLeadAtual(lead.status, lead.desfecho);
    const novo = r.is_lead;
    const concorda = atual === null || novo === null ? '?' : (atual === novo ? 'OK' : 'DIVERGE');
    linhas.push({
      cohort: lead.cohort, nome: short(lead.name, 20), turns: conversa.length,
      atual, novo, conf: r.confidence, intent: r.intent, concorda,
      reasoning: short(r.reasoning, 90),
    });
    // Linha verbosa imediata (caso a tabela final corte algo).
    console.log(`[${lead.cohort}] ${short(lead.name, 22)} | turns=${conversa.length} | atual=${atual} novo=${novo} conf=${r.confidence} ${concorda} | intent=${r.intent} | ${short(r.reasoning, 110)}`);
  }

  // -- TABELA final --
  console.log('\n================== TABELA DE VALIDAÇÃO ==================');
  const head = ['coorte', 'caso', 'turns', 'sist', 'novo', 'conf', 'conf?', 'intent', 'reasoning'];
  console.log(head.join(' | '));
  for (const l of linhas) {
    console.log([
      l.cohort, l.nome, l.turns,
      l.atual === null ? '?' : (l.atual ? 'lead' : 'não'),
      l.novo === null ? 'ERR' : (l.novo ? 'lead' : 'não'),
      l.conf === null ? '-' : l.conf.toFixed(2),
      l.concorda, l.intent || '-', l.reasoning,
    ].join(' | '));
  }

  // -- Métricas nos dois sentidos --
  const fpL = linhas.filter((l) => l.cohort === 'FALSO-POSITIVO');
  const cvL = linhas.filter((l) => l.cohort === 'CONVERTIDO/QUALIF');
  const nlL = linhas.filter((l) => l.cohort === 'NOT_LEAD');
  const cnt = (arr, pred) => arr.filter(pred).length;
  console.log('\n================== MÉTRICAS ==================');
  console.log(`Falsos-positivos corrigidos (esperado novo=não): ${cnt(fpL, (l) => l.novo === false)}/${fpL.length}`);
  console.log(`Convertidos/qualificados mantidos (esperado novo=lead): ${cnt(cvL, (l) => l.novo === true)}/${cvL.length}`);
  console.log(`NOT_LEAD que o novo RECUPERARIA como lead: ${cnt(nlL, (l) => l.novo === true)}/${nlL.length}`);
  console.log(`Modelo Gemini ativo: ${gemini.getActiveModel()}`);

  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
