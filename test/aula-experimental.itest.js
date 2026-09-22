'use strict';
//
// aula-experimental.itest.js — A ETAPA "AULA EXPERIMENTAL" TEM PORTA DE SAÍDA.
//
// O CASO (22/09/2026, medido em Valinhos): 60 leads parados em EXPERIMENTAL_AGENDADA — 37 com a
// aula marcada para uma data que JÁ PASSOU e 18 com a aula JÁ REALIZADA e ninguém movendo o card.
// 28 deles parados há mais de um mês. E a fila de ação os excluía DE PROPÓSITO ("está parado
// aguardando a aula, não a recepção"), o que está certo ENQUANTO a aula não chega — e vira um
// buraco no dia seguinte: são as pessoas mais quentes do funil, que já vieram à escola, e ninguém
// era avisado de cobrá-las.
//
// A porta de saída é o próprio FATO da Extranet, que o sistema já guardava e não usava para nada:
//   • aula realizada → 'aula_feita'          (cobrar a matrícula)
//   • aula vencida   → 'aula_nao_aconteceu'  (remarcar)
//   • sem fato       → só depois de 14 dias parado (o tempo é a única evidência que sobra)
//
// A regra NÃO pode contaminar o SLA: quem já veio à escola não é dívida de RESPOSTA (ninguém está
// esperando uma mensagem), é dívida de FOLLOW-UP. Por isso não entra em `aguardando_resposta`.
//
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Client } = require('pg');

const T = '00000000-0000-4000-8000-0000000eaa1a';
let c;

const dbPath = require.resolve(path.join(__dirname, '../src/db.js'));
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: { withTenant: async (_t, fn) => fn(c), pool: { query: (...a) => c.query(...a) }, q: (...a) => c.query(...a) },
};
const { computePainel } = require('../src/metrics.js');

const DIA = 86400e3;

async function lead(nome, telefone, { status = 'EXPERIMENTAL_AGENDADA', paradoDias = 1 } = {}) {
  return (await c.query(
    `INSERT INTO leads (tenant_id, name, phone, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4, now() - interval '60 days', now() - make_interval(days => $5)) RETURNING id`,
    [T, nome, telefone, status, paradoDias])).rows[0].id;
}
const conversa = async (tel) => (await c.query(
  `INSERT INTO conversations (tenant_id, channel, external_id) VALUES ($1,'whatsapp',$2) RETURNING id`, [T, tel])).rows[0].id;
const entrada = (cv, body, hAtras) => c.query(
  `INSERT INTO messages (conversation_id, role, body, received_at) VALUES ($1,'USER',$2, now() - make_interval(hours => $3))`, [cv, body, hAtras]);
const saida = (tel, body, hAtras) => c.query(
  `INSERT INTO staff_outbound_samples (tenant_id, external_id, body, received_at) VALUES ($1,$2,$3, now() - make_interval(hours => $4))`, [T, tel, body, hAtras]);
const fato = (leadId, { agendadaDias = null, realizadaDias = null, situacao = 'Exp. Agendada' } = {}) => c.query(
  `INSERT INTO extranet_lead (lead_id, tenant_id, situacao, exp_agendada_em, exp_realizada_em, last_seen_at)
   VALUES ($1,$2,$3,
     CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(days => $4::int) END,
     CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(days => $5::int) END,
     now())`,
  [leadId, T, situacao, agendadaDias, realizadaDias]);

const naFila = (p, id) => (p.fila || []).find((x) => x.id === id) || null;

let idFutura, idVencida, idRealizada, idSemFatoParado, idSemFatoRecente, idRespondeAgora;

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`
    CREATE TABLE leads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, name text, phone text, meta_psid text,
      status text, intent text, desfecho text, desfecho_em timestamptz, temperatura_manual text, origem text,
      review_queue boolean, review_result text, classification_confidence numeric, classification_reasoning text,
      conversation_state text, state_computed_at timestamptz, suggested_stage text, stage_reasoning text,
      aborda_renovacao boolean, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE TABLE lead_qualifications (lead_id uuid, tenant_id uuid, instrument text, qualification_complete boolean, name text, availability text, reasked boolean);
    CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, channel text, external_id text,
      conversation_kind text DEFAULT 'DIRECT', updated_at timestamptz DEFAULT now());
    CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, role text, body text,
      media_transcription text, received_at timestamptz DEFAULT now());
    CREATE TABLE staff_outbound_samples (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, external_id text,
      body text, sender text, raw jsonb, received_at timestamptz DEFAULT now());
    CREATE TABLE pending_approvals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, lead_id uuid, status text,
      suggested_response text, decided_at timestamptz, created_at timestamptz DEFAULT now());
    CREATE TABLE reabordagem_tentativas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, lead_id uuid, status text, enviado_em timestamptz);
    CREATE TABLE extranet_lead (lead_id uuid, tenant_id uuid, situacao text,
      exp_agendada_em timestamptz, exp_realizada_em timestamptz, last_seen_at timestamptz);
    CREATE TABLE tenant_lead_config (tenant_id uuid PRIMARY KEY, dormancy_days int DEFAULT 7);
    CREATE TABLE tenants (id uuid PRIMARY KEY, name text, horario_comercial jsonb, horario_comercial_inicio time, horario_comercial_fim time, horario_comercial_dias int[]);
  `);
  await c.query(`INSERT INTO tenants (id, name) VALUES ($1,'Teste')`, [T]);
  await c.query(`INSERT INTO tenant_lead_config (tenant_id, dormancy_days) VALUES ($1, 7)`, [T]);

  // (A) aula MARCADA para daqui a 3 dias — tem de continuar fora (é o comportamento que protege
  //     quem está esperando a aula de aparecer como "não respondemos").
  idFutura = await lead('Aula futura', '5519900000001');
  await fato(idFutura, { agendadaDias: -3 });

  // (B) aula marcada há 20 dias e nunca realizada
  idVencida = await lead('Aula vencida', '5519900000002');
  await fato(idVencida, { agendadaDias: 20 });

  // (C) aula REALIZADA há 30 dias e ninguém moveu o card
  idRealizada = await lead('Aula realizada', '5519900000003');
  await fato(idRealizada, { agendadaDias: 31, realizadaDias: 30, situacao: 'Exp. Realizada' });

  // (D) sem ficha na Extranet, parado há 20 dias / (E) sem ficha, parado há 3 dias
  idSemFatoParado = await lead('Sem fato parado', '5519900000004', { paradoDias: 20 });
  idSemFatoRecente = await lead('Sem fato recente', '5519900000005', { paradoDias: 3 });

  // (F) controle: lead normal que escreveu e não foi respondido — o SLA não pode mudar
  idRespondeAgora = await lead('Esperando resposta', '5519900000006', { status: 'QUALIFYING' });
  const cv = await conversa('5519900000006');
  await entrada(cv, 'oi, quanto custa?', 50);
  await saida('5519900000006', 'oi! já te explico', 49);
  await entrada(cv, 'e tem vaga de manhã?', 48);
});
after(async () => { await c.end(); });

test('(1) aula ainda por vir continua FORA da fila (não regrediu o que protegia)', async () => {
  assert.equal(naFila(await computePainel(T), idFutura), null);
});

test('(2) aula marcada que já passou volta como "aula não aconteceu", com o relógio na data da aula', async () => {
  const l = naFila(await computePainel(T), idVencida);
  assert.ok(l, 'o lead voltou a existir para a recepção');
  assert.equal(l.tipo, 'aula_nao_aconteceu');
  const dias = l.detalhe_seg / 86400;
  assert.ok(dias > 19 && dias < 21, `o relógio conta desde a AULA (20 dias), veio ${dias.toFixed(1)}`);
});

test('(3) aula realizada volta como "aula feita" — é o lead mais quente do funil', async () => {
  const l = naFila(await computePainel(T), idRealizada);
  assert.ok(l);
  assert.equal(l.tipo, 'aula_feita');
  const dias = l.detalhe_seg / 86400;
  assert.ok(dias > 29 && dias < 31, `conta desde a aula realizada, veio ${dias.toFixed(1)}`);
});

test('(4) sem ficha na Extranet: volta só depois da carência, não no dia seguinte', async () => {
  const p = await computePainel(T);
  assert.equal(naFila(p, idSemFatoParado).tipo, 'aula_nao_aconteceu', 'parado há 20 dias volta');
  assert.equal(naFila(p, idSemFatoRecente), null, 'parado há 3 dias ainda espera a aula');
});

test('(5) os leads de aula NÃO entram no SLA de resposta (dívida de follow-up, não de resposta)', async () => {
  const p = await computePainel(T);
  assert.equal(p.resumo.aguardando_resposta, 1, 'só o lead que realmente escreveu e não foi respondido');
  assert.equal(naFila(p, idRespondeAgora).tipo, 'responder_agora');
});

test('(6) ordem da fila: quem espera resposta primeiro, depois a aula, depois o resto', async () => {
  const tipos = (await computePainel(T)).fila.map((x) => x.tipo);
  assert.equal(tipos[0], 'responder_agora', 'quem está esperando uma mensagem continua no topo');
  assert.ok(tipos.indexOf('aula_feita') < tipos.indexOf('aula_nao_aconteceu'),
    'aula feita (cobrar matrícula) vem antes de aula não realizada (remarcar)');
});
