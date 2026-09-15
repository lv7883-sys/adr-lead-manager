'use strict';
// wa-eventos.itest.js — paridade 6 (15/09/2026): ligação e eventos de grupo viram aviso na conversa, como no
// WhatsApp. Ligação conta como não lida; aviso de grupo não. PG descartável, sem mock.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const ev = require('../src/waEventos');
const { naoEhReacaoSql } = require('../src/reacao');

let c;
const T1 = '00000000-0000-0000-0000-0000000000d6';
const GRUPO = '120363000000000055@g.us';
const run = async (_t, fn) => fn(c);

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`
    CREATE OR REPLACE FUNCTION br_phone_key(x text) RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
      WITH d AS (SELECT regexp_replace(coalesce(x, ''), '[^0-9]', '', 'g') AS v),
           loc AS (SELECT CASE WHEN length(v) IN (12,13) AND left(v,2)='55' THEN substr(v,3) ELSE v END AS v FROM d)
      SELECT CASE WHEN length(v)=11 AND substr(v,3,1)='9' THEN left(v,2)||substr(v,4) ELSE v END FROM loc
    $fn$;
    CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, channel text, external_id text,
      conversation_kind text DEFAULT 'DIRECT', updated_at timestamptz DEFAULT now(), last_read_at timestamptz,
      br_key text GENERATED ALWAYS AS (br_phone_key(external_id)) STORED, UNIQUE (tenant_id, channel, external_id));
    CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, conversation_id uuid, direction text, role text,
      external_message_id text, sender text, body text, raw jsonb, received_at timestamptz DEFAULT now(), conteudo jsonb);
    CREATE UNIQUE INDEX m_uq ON messages (tenant_id, external_message_id) WHERE external_message_id IS NOT NULL;
    CREATE TABLE wa_lid (tenant_id uuid, lid text, pn text, proprio boolean DEFAULT false, visto_em timestamptz DEFAULT now(), PRIMARY KEY (tenant_id, lid));
  `);
});
after(async () => { await c.end(); });
const linhas = async (ext) => (await c.query(
  `SELECT m.*, cv.external_id FROM messages m JOIN conversations cv ON cv.id = m.conversation_id WHERE m.external_message_id LIKE $1 ORDER BY received_at`, [ext])).rows;

test('(1) ligação perdida: toca -> não atendida -> "📞 Chamada de voz perdida", uma bolha só, na conversa do número', async () => {
  await c.query(`INSERT INTO conversations (tenant_id, channel, external_id) VALUES ($1,'whatsapp','5519999990001')`, [T1]);
  const base = { id: 'CALL1', from: '5519999990001@s.whatsapp.net', isVideo: false, isGroup: false, date: new Date().toISOString() };
  await ev.registrarChamada(T1, { ...base, status: 'offer' }, { withTenant: run });
  let r = await linhas('call:CALL1');
  assert.equal(r.length, 1);
  assert.equal(r[0].body, '📞 Chamada de voz');
  await ev.registrarChamada(T1, { ...base, status: 'terminate' }, { withTenant: run });
  r = await linhas('call:CALL1');
  assert.equal(r.length, 1);
  assert.equal(r[0].body, '📞 Chamada de voz perdida');
  assert.equal(r[0].conteudo.tipo, 'chamada');
  assert.equal(r[0].external_id, '5519999990001');
  const n = (await c.query(`SELECT count(*)::int n FROM messages m WHERE m.external_message_id='call:CALL1' AND ${naoEhReacaoSql('m')}`)).rows[0].n;
  assert.equal(n, 1, 'ligação conta como não lida');
});

test('(2) ligação de vídeo atendida e depois encerrada continua atendida (não vira perdida)', async () => {
  const base = { id: 'CALL2', from: '5519999990001@s.whatsapp.net', isVideo: true, isGroup: false };
  await ev.registrarChamada(T1, { ...base, status: 'offer' }, { withTenant: run });
  await ev.registrarChamada(T1, { ...base, status: 'accept' }, { withTenant: run });
  await ev.registrarChamada(T1, { ...base, status: 'terminate' }, { withTenant: run });
  const r = await linhas('call:CALL2');
  assert.equal(r[0].body, '📞 Chamada de vídeo');
  assert.equal(r[0].conteudo.estado, 'atendida');
});

test('(3) ligação de quem nunca escreveu cria a conversa; @lid usa o número aprendido', async () => {
  await c.query(`INSERT INTO wa_lid (tenant_id, lid, pn) VALUES ($1,'777@lid','5519988887777@s.whatsapp.net')`, [T1]);
  const r = await ev.registrarChamada(T1, { id: 'CALL3', from: '777@lid', isVideo: false, isGroup: false, status: 'reject' }, { withTenant: run });
  assert.equal(r[0].resultado, 'recusada');
  const l = await linhas('call:CALL3');
  assert.equal(l[0].external_id, '5519988887777');
  assert.equal(l[0].body, '📞 Chamada de voz recusada');
});

test('(4) grupo: adicionou / entrou / saiu / removeu / admin, com nomes, e não contam como não lida', async () => {
  await c.query(`INSERT INTO conversations (tenant_id, channel, external_id, conversation_kind) VALUES ($1,'whatsapp',$2,'GROUP')`, [T1, GRUPO]);
  const g = (await c.query(`SELECT id FROM conversations WHERE external_id=$1`, [GRUPO])).rows[0].id;
  await c.query(`INSERT INTO messages (tenant_id, conversation_id, role, sender, body, raw, external_message_id) VALUES ($1,$2,'USER','Maria','oi',$3,'G0')`,
    [T1, g, { data: { key: { remoteJid: GRUPO, participant: '100@lid' } } }]);
  await c.query(`INSERT INTO wa_lid (tenant_id, lid, pn, proprio) VALUES ($1,'999@lid',NULL,true)`, [T1]);
  const a = await ev.registrarParticipantes(T1, { id: GRUPO, author: '100@lid', action: 'add', participants: ['200@lid'], participantsData: [{ jid: '200@lid', phoneNumber: '5519911112222' }] }, { withTenant: run });
  assert.deepEqual(a, ['Maria adicionou +55 19 91111-2222']);
  const b = await ev.registrarParticipantes(T1, { id: GRUPO, action: 'add', participants: ['300@lid'], participantsData: [{ jid: '300@lid', name: 'João' }] }, { withTenant: run });
  assert.deepEqual(b, ['João entrou']);
  assert.deepEqual(await ev.registrarParticipantes(T1, { id: GRUPO, author: '100@lid', action: 'remove', participants: ['100@lid'] }, { withTenant: run }), ['Maria saiu']);
  assert.deepEqual(await ev.registrarParticipantes(T1, { id: GRUPO, author: '999@lid', action: 'remove', participants: ['300@lid'], participantsData: [{ jid: '300@lid', name: 'João' }] }, { withTenant: run }), ['Você removeu João']);
  assert.deepEqual(await ev.registrarParticipantes(T1, { id: GRUPO, author: '999@lid', action: 'promote', participants: ['100@lid'] }, { withTenant: run }), ['Maria agora é admin']);
  const n = (await c.query(`SELECT count(*)::int n FROM messages m WHERE m.conversation_id=$1 AND m.external_message_id LIKE 'sis:%' AND ${naoEhReacaoSql('m')}`, [g])).rows[0].n;
  assert.equal(n, 0, 'aviso de grupo não é não lida');
  await ev.registrarParticipantes(T1, { id: GRUPO, author: '100@lid', action: 'add', participants: ['200@lid'], participantsData: [{ jid: '200@lid', phoneNumber: '5519911112222' }] }, { withTenant: run });
  assert.equal((await linhas('sis:%')).length, 5, 'reenvio do mesmo evento não duplica');
});

test('(5) grupo: nome, descrição e só-admins', async () => {
  const r = await ev.registrarMudancaGrupo(T1, [{ id: GRUPO, author: '100@lid', subject: 'Pais da Turma de Sábado', announce: true }], { withTenant: run });
  assert.deepEqual(r, ['Maria mudou o nome do grupo para "Pais da Turma de Sábado"', 'Maria mudou as configurações para que só admins possam enviar mensagens']);
  const d = await ev.registrarMudancaGrupo(T1, { id: GRUPO, desc: 'Avisos da turma' }, { withTenant: run });
  assert.deepEqual(d, ['Alguém mudou a descrição do grupo']);
});

test('(6) roteador: só ligação e eventos de grupo param o webhook', () => {
  assert.equal(ev.tratarEvento(T1, { event: 'messages.upsert', data: {} }), false);
});
