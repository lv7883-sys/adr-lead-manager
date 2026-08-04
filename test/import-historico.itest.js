'use strict';
// import-historico.itest.js — backfill de histórico na timeline: mapper puro + inserção idempotente
// (inbound->messages, outbound->staff_outbound), dedup por external_message_id. SEM triagem/lead/Janis.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const imp = require('../src/importHistorico');

let c;
const T1 = '00000000-0000-0000-0000-0000000000ab';
const EXT = '5519999990002';

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`
    CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, channel text NOT NULL,
      external_id text, updated_at timestamptz DEFAULT now(), UNIQUE (tenant_id, channel, external_id));
    CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, conversation_id uuid,
      direction text NOT NULL, role text, external_message_id text, sender text, body text, raw jsonb,
      received_at timestamptz NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX uq_msg_ext ON messages (tenant_id, external_message_id) WHERE external_message_id IS NOT NULL;
    CREATE TABLE staff_outbound_samples (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, channel text NOT NULL,
      external_id text, external_message_id text, source text, sender text, body text, raw jsonb,
      received_at timestamptz NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX uq_so_ext ON staff_outbound_samples (tenant_id, external_message_id) WHERE external_message_id IS NOT NULL;
  `);
});
after(async () => { await c.end(); });

const nMsg = async () => (await c.query(`SELECT count(*)::int n FROM messages WHERE tenant_id=$1`, [T1])).rows[0].n;
const nOut = async () => (await c.query(`SELECT count(*)::int n FROM staff_outbound_samples WHERE tenant_id=$1`, [T1])).rows[0].n;

test('(1) mapEvolutionMsg: conversation / extendedText / fromMe / sem key', () => {
  assert.equal(imp.mapEvolutionMsg({ key: { id: 'A', fromMe: false }, message: { conversation: 'oi' }, pushName: 'Ana', messageTimestamp: 1700000000 }).body, 'oi');
  const e = imp.mapEvolutionMsg({ key: { id: 'B', fromMe: true }, message: { extendedTextMessage: { text: 'resp' } }, messageTimestamp: 1700000001 });
  assert.equal(e.body, 'resp'); assert.equal(e.fromMe, true); assert.equal(e.atMs, 1700000001000);
  assert.equal(imp.mapEvolutionMsg({ message: {} }), null);
});

test('(2) importa inbound->messages e outbound->staff_outbound', async () => {
  const r = await imp.importarConversa(T1, { channel: 'whatsapp', externalId: EXT, msgs: [
    { externalMessageId: 'H1', fromMe: false, body: 'oi, tem aula?', sender: 'Ana', atMs: 1700000000000 },
    { externalMessageId: 'H2', fromMe: true, body: 'temos sim!', sender: 'RECEP', atMs: 1700000100000 },
  ] });
  assert.equal(r.inseridos, 2);
  assert.equal(await nMsg(), 1);
  assert.equal(await nOut(), 1);
  const m = (await c.query(`SELECT role, body, raw FROM messages WHERE external_message_id='H1'`)).rows[0];
  assert.equal(m.role, 'USER'); assert.equal(m.body, 'oi, tem aula?'); assert.equal(m.raw.source, 'historico');
  const o = (await c.query(`SELECT source, body FROM staff_outbound_samples WHERE external_message_id='H2'`)).rows[0];
  assert.equal(o.source, 'historico'); assert.equal(o.body, 'temos sim!');
});

test('(3) idempotente: reimportar a mesma leva não duplica', async () => {
  const r = await imp.importarConversa(T1, { channel: 'whatsapp', externalId: EXT, msgs: [
    { externalMessageId: 'H1', fromMe: false, body: 'oi, tem aula?', sender: 'Ana' },
    { externalMessageId: 'H2', fromMe: true, body: 'temos sim!', sender: 'RECEP' },
  ] });
  assert.equal(r.inseridos, 0); assert.equal(r.pulados, 2);
  assert.equal(await nMsg(), 1); assert.equal(await nOut(), 1);
});

test('(4) pula mensagem sem id ou sem conteúdo', async () => {
  const r = await imp.importarConversa(T1, { channel: 'whatsapp', externalId: EXT, msgs: [
    { externalMessageId: null, fromMe: false, body: 'sem id' },
    { externalMessageId: 'H9', fromMe: false, body: '', sender: null },
  ] });
  assert.equal(r.inseridos, 0); assert.equal(r.pulados, 2);
});

test('(5) leva vazia / args faltando -> no-op', async () => {
  assert.equal((await imp.importarConversa(T1, { externalId: EXT, msgs: [] })).inseridos, 0);
  assert.equal((await imp.importarConversa(T1, { externalId: null, msgs: [{ externalMessageId: 'X', body: 'a' }] })).inseridos, 0);
});
