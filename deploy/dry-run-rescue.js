'use strict';
/*
 * deploy/dry-run-rescue.js — prova/impacto da correção do Gate 0 (rescue com CONVERSA).
 * READ-ONLY: só SELECT no DB + chamadas Gemini. NÃO escreve nada, NÃO envia nada.
 *
 * Roda com o .env do container (DATABASE_URL + GEMINI_API_KEY + GEMINI_MODEL):
 *   node deploy/dry-run-rescue.js cases  55199...  55198...   # 1 telefone por caso
 *   node deploy/dry-run-rescue.js impact 40                    # últimos 40 hard do gate_shadow_log
 *   node deploy/dry-run-rescue.js demo                         # 4 arquétipos (sem DB)
 *
 * Espelha o prompt REAL de gemini.js:classifyRescue (mesmo texto, temp 0) mas captura
 * usageMetadata (tokens reais). Usa as funções REAIS do engine para montar a conversa
 * exatamente como o Gate 0 monta em produção (_carregarConversaSaida + _rescueConversation).
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

function _formatConversa(conversation) {
  if (!Array.isArray(conversation) || !conversation.length) return '(sem histórico)';
  return conversation.map((m) => {
    const quem = String(m.role).toUpperCase() === 'ASSISTANT' ? 'ATENDIMENTO' : 'LEAD';
    const txt = String(m.content ?? m.body ?? m.text ?? '').replace(/\s+/g, ' ').trim();
    if (!txt) return null;
    const ts = m.at ? ` [${new Date(m.at).toISOString().slice(0, 16).replace('T', ' ')}]` : '';
    return `${quem}${ts}: ${txt}`;
  }).filter(Boolean).join('\n');
}
function buildPrompt({ message, conversation, criterio }) {
  const conteudo = (Array.isArray(conversation) && conversation.length)
    ? `CONVERSA (cronológica):\n${_formatConversa(conversation)}`
    : `MENSAGEM: """${message ?? ''}"""`;
  return `Você avalia se a conversa/mensagem de um CONTATO CONHECIDO do negócio representa um LEAD
(uma OPORTUNIDADE DE NOVO NEGÓCIO) segundo o CRITÉRIO DO PAPEL abaixo. Por padrão, contato conhecido em
assunto de rotina/pós-venda NÃO é lead; só é lead se o critério de RESGATE for satisfeito. A INTENÇÃO da
conversa decide, nunca a identidade.

CRITÉRIO DE RESGATE (do papel, deste cliente):
${criterio}

${conteudo}

Responda SOMENTE com JSON: {"resgata":<true|false>,"confidence":<0.0-1.0>,"motivo":"<1 frase em pt-BR citando o conteúdo>"}
- resgata=true → é lead (MANTÉM no funil). resgata=false → é rotina/pós-venda/operacional (descarta).
- "confidence" = certeza da decisão (0.0-1.0). Na dúvida REAL, prefira resgata=true — precisão sobre recall no descarte (não descartar lead bom).`;
}
async function rescue({ message, conversation, criterio }) {
  const model = genai.getGenerativeModel({ model: MODEL, generationConfig: { responseMimeType: 'application/json', temperature: 0 } });
  const res = await model.generateContent(buildPrompt({ message, conversation, criterio }));
  const parsed = JSON.parse(res.response.text());
  const u = res.response.usageMetadata || {};
  return { resgata: !!parsed.resgata, confidence: parsed.confidence, motivo: parsed.motivo,
    promptTokens: u.promptTokenCount, outTokens: u.candidatesTokenCount };
}

// —— modos com DB (host) ——
async function withDb(fn) {
  const engine = require('../src/engine');
  const { getRescuePolicy } = require('../src/roleLeadPolicy');
  const { withTenant, pool } = require('../src/db');
  try { return await fn({ engine, getRescuePolicy, withTenant }); }
  finally { try { await pool.end(); } catch {} try { require('../src/redisClient').redis.disconnect(); } catch {} }
}
// tenant único do rollout (Valinhos). Ajustar se multi-tenant.
async function resolveTenant(withTenant) {
  const { pool } = require('../src/db');
  const r = await pool.query("SELECT id, name FROM tenants ORDER BY name LIMIT 1");
  return r.rows[0];
}
async function runCases(phones) {
  await withDb(async ({ engine, getRescuePolicy }) => {
    const t = await resolveTenant();
    console.log(`tenant=${t.name} (${t.id})  MODEL=${MODEL}  tail_cap=${engine.RESCUE_CONV_MAX}\n`);
    for (const raw of phones) {
      const ident = String(raw).replace(/\D/g, '');
      const role = await engine._lookupRole(t.id, ident);
      const pol = await getRescuePolicy(t.id, role && role.key);
      const hist = await engine._carregarConversaSaida(t.id, ident, null);
      const atual = hist.length ? hist[hist.length - 1].content : '(sem histórico)';
      const conv = engine._rescueConversation(hist, null); // hist já inclui a última msg persistida
      if (!pol.rescue_prompt) { console.log(`── ${ident}: papel=${role && role.key || '—'} SEM rescue_prompt → default seguro (mantém). pula.\n`); continue; }
      const r = await rescue({ message: atual, conversation: conv, criterio: pol.rescue_prompt });
      console.log(`── ${ident}  papel=${role && role.key}  turns=${conv.length}`);
      console.log(`   → ${r.resgata ? 'MANTÉM' : 'DESCARTA'}  conf=${r.confidence}  tokens=${r.promptTokens}p/${r.outTokens}o`);
      console.log(`   motivo: ${r.motivo}\n`);
    }
  });
}
async function runImpact(n) {
  await withDb(async ({ engine, getRescuePolicy, withTenant }) => {
    const t = await resolveTenant();
    const rows = await withTenant(t.id, (c) => c.query(
      `SELECT phone, reason FROM gate_shadow_log
        WHERE would_action='hard' AND reason LIKE 'role:%rescue:%' AND phone IS NOT NULL
        ORDER BY created_at DESC LIMIT $1`, [n])).then((r) => r.rows);
    console.log(`tenant=${t.name}  amostra=${rows.length} decisões hard recentes\n`);
    let flips = 0, avaliados = 0;
    for (const row of rows) {
      const before = /rescue:keep/.test(row.reason) ? 'keep' : 'discard';
      const roleKey = (row.reason.match(/role:([^|]*)/) || [])[1] || '';
      const pol = await getRescuePolicy(t.id, roleKey);
      if (!pol.rescue_prompt) continue;
      const ident = String(row.phone).replace(/\D/g, '');
      const hist = await engine._carregarConversaSaida(t.id, ident, null);
      const conv = engine._rescueConversation(hist, null);
      const atual = hist.length ? hist[hist.length - 1].content : '';
      const r = await rescue({ message: atual, conversation: conv, criterio: pol.rescue_prompt });
      const after = r.resgata ? 'keep' : 'discard';
      avaliados++;
      if (after !== before) { flips++; console.log(`FLIP ${ident}: ${before} → ${after}  (${r.motivo})`); }
    }
    console.log(`\nIMPACTO: ${flips}/${avaliados} decisões mudariam com a conversa (${(100 * flips / Math.max(1, avaliados)).toFixed(1)}%).`);
  });
}

(async () => {
  const mode = process.argv[2] || 'demo';
  if (mode === 'cases') return runCases(process.argv.slice(3));
  if (mode === 'impact') return runImpact(Number(process.argv[3] || 40));
  console.log('demo: use scratchpad/dry-run-rescue.js (arquétipos). Modos com DB: cases | impact.');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
