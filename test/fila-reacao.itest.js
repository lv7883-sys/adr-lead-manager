'use strict';
//
// fila-reacao.itest.js — REAÇÃO NÃO É TURNO: a fila de ação e o kanban rodando de verdade.
//
// O CASO (22/09/2026, relatado pela recepção): um lead aparecia na FILA DE AÇÃO como
// "responder agora · cliente esperando há 5d 17h", mas na conversa a recepção já tinha respondido —
// depois da resposta o cliente só mandou 🙏. As três consultas do metrics.js calculavam o "último
// contato do lead" com `max(received_at)` incluindo reação, então:
//   • a reação passava a ser "contato do cliente mais recente que a nossa resposta" → responder agora;
//   • e, por ser posterior ao `state_computed_at`, invalidava o veredito da IA (AGUARDANDO_CLIENTE),
//     jogando a decisão no fallback heurístico. A mesma tela se contradizia: o card do topo
//     (que respeita o estado da IA) dizia uma coisa e a fila, outra.
//
// Aqui rodam as FUNÇÕES REAIS (computePainel/computeKanban/computeMetrics) contra um Postgres
// descartável, com o cliente injetado no lugar do withTenant.
//
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Client } = require('pg');

const T = '00000000-0000-4000-8000-00000000f11a';
let c;

// withTenant do db.js trocado pelo cliente do teste (mesmo truque dos outros itests).
const dbPath = require.resolve(path.join(__dirname, '../src/db.js'));
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { withTenant: async (_t, fn) => fn(c), pool: { query: (...a) => c.query(...a) }, q: (...a) => c.query(...a) },
};
const { computePainel, computeKanban, computeMetrics } = require('../src/metrics.js');

const REACAO = '[reação] 🙏🏼';
const SISTEMA = '⁣Fulano entrou no grupo';

async function lead(nome, telefone, over = {}) {
  return (await c.query(
    `INSERT INTO leads (tenant_id, name, phone, status, conversation_state, state_computed_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() - interval '20 days') RETURNING id`,
    [T, nome, telefone, over.status || 'QUALIFYING', over.estado || null, over.estadoEm || null])).rows[0].id;
}
async function conversa(telefone) {
  return (await c.query(
    `INSERT INTO conversations (tenant_id, channel, external_id, updated_at) VALUES ($1,'whatsapp',$2, now()) RETURNING id`,
    [T, telefone])).rows[0].id;
}
const entrada = (convId, body, horasAtras) => c.query(
  `INSERT INTO messages (conversation_id, role, body, received_at) VALUES ($1,'USER',$2, now() - make_interval(hours => $3))`,
  [convId, body, horasAtras]);
const saida = (telefone, body, horasAtras) => c.query(
  `INSERT INTO staff_outbound_samples (tenant_id, external_id, body, received_at) VALUES ($1,$2,$3, now() - make_interval(hours => $4))`,
  [T, telefone, body, horasAtras]);

const doPainel = (r, id) => (r.fila || []).find((x) => x.id === id) || null;
function doKanban(r, id) {
  for (const col of ['novo', 'qualificando', 'qualificado', 'experimental', 'convertido', 'perdido']) {
    const hit = (r[col] || []).find((x) => x.id === id);
    if (hit) return hit;
  }
  return null;
}

let idReacao, idSistema, idEsperando, idSoReacao;

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`
    CREATE TABLE leads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, name text, phone text, meta_psid text,
      status text, intent text, desfecho text, desfecho_em timestamptz, temperatura_manual text, origem text,
      review_queue boolean, review_result text, classification_confidence numeric, classification_reasoning text,
      conversation_state text, state_computed_at timestamptz, suggested_stage text, stage_reasoning text,
      aborda_renovacao boolean, created_at timestamptz DEFAULT now());
    CREATE TABLE lead_qualifications (lead_id uuid, tenant_id uuid, instrument text, qualification_complete boolean, name text, availability text, reasked boolean);
    CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, channel text, external_id text,
      conversation_kind text DEFAULT 'DIRECT', updated_at timestamptz DEFAULT now());
    CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, role text, body text,
      media_transcription text, received_at timestamptz DEFAULT now());
    CREATE TABLE staff_outbound_samples (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, external_id text,
      body text, sender text, raw jsonb, received_at timestamptz DEFAULT now());
    CREATE TABLE pending_approvals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, lead_id uuid, status text, created_at timestamptz DEFAULT now());
    CREATE TABLE reabordagem_tentativas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, lead_id uuid, status text);
    CREATE TABLE tenant_lead_config (tenant_id uuid PRIMARY KEY, dormancy_days int DEFAULT 7);
    CREATE TABLE tenants (id uuid PRIMARY KEY, name text, horario_comercial jsonb, horario_comercial_inicio time, horario_comercial_fim time, horario_comercial_dias int[]);
  `);
  await c.query(`INSERT INTO tenants (id, name) VALUES ($1,'Teste')`, [T]);
  await c.query(`INSERT INTO tenant_lead_config (tenant_id, dormancy_days) VALUES ($1, 7)`, [T]);

  // (A) o caso relatado: cliente escreveu, RESPONDEMOS, e depois ele só reagiu com 🙏
  const telA = '5519981752393';
  idReacao = await lead('Com reação', telA, { estado: 'AGUARDANDO_CLIENTE', estadoEm: new Date(Date.now() - 138 * 36e5) });
  const cvA = await conversa(telA);
  await entrada(cvA, 'Olá! Posso ter mais informações sobre isso?', 140);
  await saida(telA, 'Claro! Nossos cursos…', 139);
  await entrada(cvA, REACAO, 138);

  // (B) aviso de SISTEMA do WhatsApp depois da nossa resposta — também não é turno
  const telB = '5519999990002';
  idSistema = await lead('Com aviso de sistema', telB);
  const cvB = await conversa(telB);
  await entrada(cvB, 'bom dia', 100);
  await saida(telB, 'bom dia! como posso ajudar?', 99);
  await entrada(cvB, SISTEMA, 98);

  // (C) controle: cliente escreveu DE VERDADE depois da nossa resposta — tem de cobrar resposta
  const telC = '5519999990003';
  idEsperando = await lead('Esperando mesmo', telC);
  const cvC = await conversa(telC);
  await entrada(cvC, 'oi', 50);
  await saida(telC, 'oi! tudo bem?', 49);
  await entrada(cvC, 'e os valores?', 48);

  // (D) contato que só mandou reação, sem nunca escrever nada
  const telD = '5519999990004';
  idSoReacao = await lead('Só reagiu', telD);
  const cvD = await conversa(telD);
  await saida(telD, 'oi! vi seu interesse', 30);
  await entrada(cvD, REACAO, 29);
});
after(async () => { await c.end(); });

test('(1) reação depois da nossa resposta NÃO devolve o lead para "responder agora"', async () => {
  const p = await computePainel(T);
  const l = doPainel(p, idReacao);
  assert.ok(l, 'o lead continua na tela (não some)');
  assert.notEqual(l.tipo, 'responder_agora', 'a bola é do cliente: 🙏 não é pedido de resposta');
  assert.notEqual(l.tipo, 'sem_resposta');
  assert.equal(l.tipo, 'monitorar', 'o veredito da IA (AGUARDANDO_CLIENTE) deixou de ser invalidado pela reação');
});

test('(2) aviso de sistema do WhatsApp também não conta como turno do cliente', async () => {
  const l = doPainel(await computePainel(T), idSistema);
  assert.ok(l);
  assert.notEqual(l.tipo, 'responder_agora');
});

test('(3) cliente que escreveu de verdade continua cobrando resposta (não afrouxou nada)', async () => {
  const l = doPainel(await computePainel(T), idEsperando);
  assert.equal(l.tipo, 'responder_agora');
  assert.ok(l.detalhe_seg >= 47 * 3600 && l.detalhe_seg <= 49 * 3600, 'conta desde a MENSAGEM, não desde outra coisa');
});

test('(4) quem só reagiu, sem nunca escrever, não vira fila de resposta', async () => {
  const l = doPainel(await computePainel(T), idSoReacao);
  assert.ok(l);
  assert.notEqual(l.tipo, 'responder_agora');
  assert.notEqual(l.tipo, 'sem_resposta');
});

test('(5) kanban: o badge de urgência segue a mesma régua da fila', async () => {
  const k = await computeKanban(T);
  const comReacao = doKanban(k, idReacao);
  const esperando = doKanban(k, idEsperando);
  assert.ok(comReacao && esperando, 'os dois estão no board');
  assert.equal(comReacao.bucket_urgencia || null, null, 'reação não acende badge de "responder agora"');
  assert.equal(esperando.bucket_urgencia, 'responder_agora');
});

test('(6) painel/SLA: reação não entra como "aguardando nós" nem como 1ª mensagem do lead', async () => {
  const m = await computeMetrics(T, { period: '90d' });
  const aguardando = ((m.atencao && m.atencao.aguardando_lista) || m.aguardando_lista || []).map((x) => x.id);
  assert.ok(!aguardando.includes(idReacao), 'lead do caso não aparece como "devemos resposta"');
  assert.ok(aguardando.includes(idEsperando), 'quem escreveu mesmo continua aparecendo');
});
