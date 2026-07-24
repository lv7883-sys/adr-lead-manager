'use strict';
// gate-rescue-conversa.itest.js — Gate 0: passar a CONVERSA para a rescue question (corrige o Jörg).
// Exercita as funções REAIS de src/engine.js contra Postgres efêmero:
//   (1) _rescueConversation (pura): histórico + mensagem atual, tail cap, fallback sem histórico;
//   (2) _carregarConversaSaida/loadRealHistory: carrega a conversa real, cronológica (mesma fonte
//       do classifyConversa) — é o que o gate agora envia à rescue;
//   (3) MULTI-TENANT: a conversa é resolvida pelo tenant certo (mesmo ident em 2 tenants);
//   (4) o CONTRASTE Jörg: com histórico de rotina + "Olá;", a rescue passa a julgar a CONVERSA
//       (não a saudação isolada) — mirror fiel da seleção de conteúdo do classifyRescue (gemini.js).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const engine = require('../src/engine');
const { _rescueConversation, _carregarConversaSaida, RESCUE_CONV_MAX } = engine;

let c;
const T1 = '00000000-0000-0000-0000-0000000000c1';
const T2 = '00000000-0000-0000-0000-0000000000c2';
const IDENT = '5511973076037';   // telefone do Jörg (dígitos)

// Mirror FIEL da seleção de conteúdo do classifyRescue (gemini.js:642): conversa não-vazia vence
// a mensagem. Prova que, com a conversa, é ela (e não o "Olá;") que a rescue julga.
function conteudoRescue({ message, conversation }) {
  return (Array.isArray(conversation) && conversation.length) ? 'CONVERSA' : 'MENSAGEM';
}

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  await c.query(`
    CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, external_id text, updated_at timestamptz DEFAULT now());
    CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, role text, body text, media_type text, media_transcription text, received_at timestamptz);
    CREATE TABLE staff_outbound_samples (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, external_id text, body text, received_at timestamptz, raw jsonb);
    CREATE TABLE pending_approvals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, lead_id uuid, status text, suggested_response text, created_at timestamptz);`);

  // T1 — conversa de ROTINA de responsável (padrão Jörg): responsável avisa falta, atendimento
  // responde, responsável agradece. NENHUM sinal de novo aluno.
  const conv1 = (await c.query(
    `INSERT INTO conversations (tenant_id, external_id) VALUES ($1,$2) RETURNING id`, [T1, IDENT])).rows[0].id;
  await c.query(`INSERT INTO messages (conversation_id, role, body, received_at) VALUES
    ($1,'USER','Oi, o Nico vai faltar na aula de amanhã', now()-interval '10 days'),
    ($1,'USER','obrigada!', now()-interval '2 days')`, [conv1]);
  await c.query(`INSERT INTO staff_outbound_samples (tenant_id, external_id, body, received_at, raw) VALUES
    ($1,$2,'Ok, avisado! Bom feriado 🎉', now()-interval '9 days', '{}'::jsonb)`, [T1, IDENT]);

  // T2 — MESMO ident, conversa DIFERENTE (isolamento por tenant).
  const conv2 = (await c.query(
    `INSERT INTO conversations (tenant_id, external_id) VALUES ($1,$2) RETURNING id`, [T2, IDENT])).rows[0].id;
  await c.query(`INSERT INTO messages (conversation_id, role, body, received_at) VALUES
    ($1,'USER','Quero matricular meu filho no violão', now()-interval '1 day')`, [conv2]);
});
after(async () => {
  await c.end();
  try { await require('../src/db').pool.end(); } catch {}
  // redisClient usa lazyConnect (nunca conectou no itest) — disconnect() libera o handle sem
  // pendurar o processo (quit() num cliente não-conectado trava o node --test no fim).
  try { require('../src/redisClient').redis.disconnect(); } catch {}
});

test('(1) _rescueConversation: histórico + mensagem atual, tail cap, fallback sem histórico', () => {
  const hist = [{ role: 'USER', content: 'a', at: 't1' }, { role: 'ASSISTANT', content: 'b', at: 't2' }];
  const r = _rescueConversation(hist, 'Olá;');
  assert.equal(r.length, 3, 'anexa a mensagem atual ao histórico');
  assert.equal(r[2].content, 'Olá;'); assert.equal(r[2].role, 'USER');
  // tail cap: 30 turnos + atual → últimos RESCUE_CONV_MAX
  const big = Array.from({ length: 30 }, (_, i) => ({ role: 'USER', content: 'm' + i, at: 't' }));
  const capped = _rescueConversation(big, 'agora');
  assert.equal(capped.length, RESCUE_CONV_MAX, 'corta no tail cap');
  assert.equal(capped[capped.length - 1].content, 'agora', 'mantém a atual (mais recente)');
  assert.equal(capped[0].content, 'm11', 'mantém só o tail (últimos 20 de 31)');
  // sem histórico → só a mensagem atual (default conservador preservado)
  assert.deepEqual(_rescueConversation([], 'Olá;').map((x) => x.content), ['Olá;']);
  assert.deepEqual(_rescueConversation(null, 'Olá;').map((x) => x.content), ['Olá;']);
});

test('(2) _carregarConversaSaida carrega a conversa real, cronológica', async () => {
  const conv = await _carregarConversaSaida(T1, IDENT, null);
  assert.ok(conv.length >= 3, 'histórico completo (2 USER + 1 ASSISTANT)');
  const textos = conv.map((m) => m.content);
  assert.ok(textos.some((t) => /Nico vai faltar/.test(t)), 'traz a msg de rotina do responsável');
  assert.ok(textos.some((t) => /avisado/.test(t)), 'traz a resposta do atendimento (staff_outbound)');
  // cronológico ASC
  const ts = conv.map((m) => new Date(m.at).getTime());
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b), 'ordem cronológica ASC');
});

test('(3) MULTI-TENANT: mesmo ident resolve a conversa do tenant certo', async () => {
  const c1 = await _carregarConversaSaida(T1, IDENT, null);
  const c2 = await _carregarConversaSaida(T2, IDENT, null);
  assert.ok(c1.map((m) => m.content).some((t) => /Nico vai faltar/.test(t)), 'T1 vê a sua rotina');
  assert.ok(!c1.map((m) => m.content).some((t) => /matricular meu filho/.test(t)), 'T1 NÃO vê a conversa do T2');
  assert.ok(c2.map((m) => m.content).some((t) => /matricular meu filho/.test(t)), 'T2 vê só a sua');
  assert.ok(!c2.map((m) => m.content).some((t) => /Nico/.test(t)), 'T2 NÃO vê a do T1');
});

test('(4) CONTRASTE Jörg: com a conversa, a rescue julga a CONVERSA, não o "Olá;"', async () => {
  // ANTES (bug): só a mensagem → conteúdo julgado = a saudação isolada.
  assert.equal(conteudoRescue({ message: 'Olá;', conversation: [] }), 'MENSAGEM');
  // DEPOIS (fix): gate monta histórico + "Olá;" e manda à rescue → julga a CONVERSA de rotina.
  const hist = await _carregarConversaSaida(T1, IDENT, null);
  const conv = _rescueConversation(hist, 'Olá;');
  assert.equal(conteudoRescue({ message: 'Olá;', conversation: conv }), 'CONVERSA');
  assert.ok(conv.map((m) => m.content).some((t) => /Nico vai faltar/.test(t)), 'a conversa de rotina chega à rescue');
  assert.equal(conv[conv.length - 1].content, 'Olá;', 'e a mensagem atual também');
});
