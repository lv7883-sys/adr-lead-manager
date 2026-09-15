'use strict';
// waEdicao.itest.js — edição cifrada aplicada na mensagem ORIGINAL, contra Postgres real (paridade 2).
// As edições são cifradas no próprio teste do jeito que o WhatsApp faz; nenhum dado real.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Client } = require('pg');
const w = require('../src/waEdicao');
const webhook = require('../src/routes/webhook');

let c;
const T1 = '00000000-0000-0000-0000-0000000000e7';
const SEGREDO = crypto.randomBytes(32);
const LID_CLIENTE = '257384589033642@lid';
const LID_ESCOLA = '249057033380082@lid';
const semOutbound = { outbound: { credsForTenant: async () => ({}) } };   // sem rede no teste

const varint = (n) => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return Buffer.from(b); };
const ld = (campo, buf) => Buffer.concat([varint((campo << 3) | 2), varint(buf.length), buf]);
const txt = (campo, s) => ld(campo, Buffer.from(s, 'utf8'));
const editado = (inner) => ld(12, Buffer.concat([ld(1, txt(3, 'X')), ld(14, inner)]));
const b64 = (b) => b.toString('base64');

function evento({ alvoId, alvoRemote, autor, key, claro }) {
  const { encIv, encPayload } = w._cifrarParaTeste({ segredo: SEGREDO, alvoId, autor, claro });
  return { key, message: { secretEncryptedMessage: {
    targetMessageKey: { id: alvoId, fromMe: true, remoteJid: alvoRemote }, secretEncType: 2, encIv: b64(encIv), encPayload: b64(encPayload) } } };
}
const rawComSegredo = (segredo = SEGREDO) => ({ data: { message: { conversation: 'x', messageContextInfo: { messageSecret: b64(segredo) } } } });
const linhas = async () => (await c.query('SELECT (SELECT count(*) FROM messages)::int + (SELECT count(*) FROM staff_outbound_samples)::int AS n')).rows[0].n;

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`
    CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, conversation_id uuid, role text,
      body text, original_body text, edited_at timestamptz, raw jsonb, external_message_id text, received_at timestamptz DEFAULT now());
    CREATE TABLE staff_outbound_samples (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, external_id text,
      body text, original_body text, edited_at timestamptz, raw jsonb, external_message_id text, received_at timestamptz DEFAULT now());
    CREATE TABLE wa_lid (tenant_id uuid NOT NULL, lid text NOT NULL, pn text, proprio boolean NOT NULL DEFAULT false,
      visto_em timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, lid));
  `);
});
after(async () => { await c.end(); });

test('(1) cliente edita no GRUPO (@lid na key) -> texto novo na original, nenhuma bolha nova', async () => {
  await c.query(`INSERT INTO messages (tenant_id, role, body, raw, external_message_id) VALUES ($1,'USER','Bom dia',$2,'M1')`, [T1, rawComSegredo()]);
  const antes = await linhas();
  const r = await w.aplicarEdicaoCifrada(T1, evento({ alvoId: 'M1', alvoRemote: '120363000000000001@g.us', autor: LID_CLIENTE, claro: editado(txt(1, 'Bom dia, ok!')),
    key: { id: 'E1', fromMe: false, remoteJid: '120363000000000001@g.us', participant: LID_CLIENTE, participantAlt: '5519992605603@s.whatsapp.net' } }), semOutbound);
  assert.equal(r.resultado, 'editada');
  const m = (await c.query(`SELECT body, original_body, edited_at FROM messages WHERE external_message_id='M1'`)).rows[0];
  assert.equal(m.body, 'Bom dia, ok!'); assert.equal(m.original_body, 'Bom dia'); assert.ok(m.edited_at);
  assert.equal(await linhas(), antes, 'a edição não vira linha');
  const par = (await c.query(`SELECT pn FROM wa_lid WHERE tenant_id=$1 AND lid=$2`, [T1, LID_CLIENTE])).rows[0];
  assert.equal(par.pn, '5519992605603@s.whatsapp.net', 'aprendeu o par número <-> @lid');
});

test('(2) cliente 1:1 sem @lid na key -> usa o par já aprendido', async () => {
  await c.query(`INSERT INTO messages (tenant_id, role, body, raw, external_message_id) VALUES ($1,'USER','Chego às 10h',$2,'M2')`, [T1, rawComSegredo()]);
  const r = await w.aplicarEdicaoCifrada(T1, evento({ alvoId: 'M2', alvoRemote: LID_ESCOLA, autor: LID_CLIENTE, claro: editado(txt(1, 'Chego às 11h')),
    key: { id: 'E2', fromMe: false, remoteJid: '5519992605603@s.whatsapp.net', remoteJidAlt: '5519992605603@s.whatsapp.net', addressingMode: 'lid' } }), semOutbound);
  assert.equal(r.resultado, 'editada');
  assert.equal((await c.query(`SELECT body FROM messages WHERE external_message_id='M2'`)).rows[0].body, 'Chego às 11h');
  const proprio = (await c.query(`SELECT proprio FROM wa_lid WHERE tenant_id=$1 AND lid=$2`, [T1, LID_ESCOLA])).rows[0];
  assert.equal(proprio && proprio.proprio, true, 'o chat do ponto de vista do cliente revela o @lid da escola');
});

test('(3) ESCOLA edita no celular (fromMe) -> usa o @lid próprio e aplica na saída', async () => {
  await c.query(`INSERT INTO staff_outbound_samples (tenant_id, external_id, body, raw, external_message_id) VALUES ($1,'5519992605603','[imagem] legenda velha',$2,'S1')`, [T1, rawComSegredo()]);
  const r = await w.aplicarEdicaoCifrada(T1, evento({ alvoId: 'S1', alvoRemote: '5519992605603@s.whatsapp.net', autor: LID_ESCOLA, claro: editado(ld(3, txt(3, 'legenda nova'))),
    key: { id: 'E3', fromMe: true, remoteJid: '5519992605603@s.whatsapp.net' } }), semOutbound);
  assert.equal(r.resultado, 'editada'); assert.equal(r.tabela, 'staff_outbound_samples');
  assert.equal((await c.query(`SELECT body FROM staff_outbound_samples WHERE external_message_id='S1'`)).rows[0].body, '[imagem] legenda nova', 'troca só a legenda');
});

test('(4) original sem segredo -> só a marca de editada, texto intacto', async () => {
  await c.query(`INSERT INTO staff_outbound_samples (tenant_id, external_id, body, raw, external_message_id) VALUES ($1,'5519992605603','Texto enviado pelo Web','{"data":{"message":{"conversation":"x"}}}','S2')`, [T1]);
  const r = await w.aplicarEdicaoCifrada(T1, evento({ alvoId: 'S2', alvoRemote: '5519992605603@s.whatsapp.net', autor: LID_ESCOLA, claro: editado(txt(1, 'y')),
    key: { id: 'E4', fromMe: true, remoteJid: '5519992605603@s.whatsapp.net' } }), semOutbound);
  assert.equal(r.resultado, 'marcada'); assert.equal(r.motivo, 'sem_segredo');
  const s = (await c.query(`SELECT body, edited_at FROM staff_outbound_samples WHERE external_message_id='S2'`)).rows[0];
  assert.equal(s.body, 'Texto enviado pelo Web'); assert.ok(s.edited_at);
});

test('(5) alvo que não temos -> nada muda, nenhuma linha criada', async () => {
  const antes = await linhas();
  const r = await w.aplicarEdicaoCifrada(T1, evento({ alvoId: 'NAO_EXISTE', alvoRemote: LID_ESCOLA, autor: LID_CLIENTE, claro: editado(txt(1, 'z')),
    key: { id: 'E5', fromMe: false, remoteJid: '5519992605603@s.whatsapp.net' } }), semOutbound);
  assert.equal(r.resultado, 'alvo_ausente');
  assert.equal(await linhas(), antes);
});

test('(6) o parse do webhook não chama mais edição de "visualização única"', () => {
  const msg = webhook.normalizeMessage({ event: 'messages.upsert', data: { key: { id: 'E6', remoteJid: '5519992605603@s.whatsapp.net', fromMe: false },
    message: { secretEncryptedMessage: { targetMessageKey: { id: 'M1' }, secretEncType: 2 } } } });
  assert.notEqual(msg.body, '[mensagem de visualização única]');
});
