'use strict';
// inbox-group.itest.js — ADR-042 E14/B1: ingestão de mensagem de GRUPO (captureGroupInbound).
// Cria conversa kind='GROUP' (external_id = jid @g.us completo) + mensagem do participante,
// SEM funil de lead. Dedup por external_message_id. Ignora jid não-grupo.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const engine = require('../src/engine');

let c;
const T1 = '00000000-0000-0000-0000-0000000000d1';
const JID = '120363402601589198@g.us';

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`
    CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, channel text,
      external_id text, conversation_kind text DEFAULT 'DIRECT', updated_at timestamptz DEFAULT now());
    CREATE UNIQUE INDEX conv_uq ON conversations (tenant_id, channel, external_id);
    CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, conversation_id uuid,
      direction text, role text, external_message_id text, sender text, body text, raw jsonb,
      media_url text, media_type text, media_filename text, media_transcription text, received_at timestamptz DEFAULT now());
    CREATE UNIQUE INDEX msg_uq ON messages (tenant_id, external_message_id) WHERE external_message_id IS NOT NULL;
  `);
});
after(async () => { await c.end(); });

const conv = async () => (await c.query(`SELECT * FROM conversations WHERE tenant_id=$1 AND external_id=$2`, [T1, JID])).rows[0];
const msgs = async (cid) => (await c.query(`SELECT * FROM messages WHERE conversation_id=$1 ORDER BY received_at`, [cid])).rows;

test('(1) captura cria conversa GROUP + mensagem do participante', async () => {
  await engine.captureGroupInbound(T1, JID, { externalMessageId: 'G1', sender: 'João (grupo)', body: 'oi galera' }, { raw: 1 });
  const cv = await conv();
  assert.ok(cv, 'conversa criada');
  assert.equal(cv.conversation_kind, 'GROUP');
  assert.equal(cv.external_id, JID, 'external_id = jid completo com @g.us');
  const m = await msgs(cv.id);
  assert.equal(m.length, 1);
  assert.equal(m[0].role, 'USER'); assert.equal(m[0].sender, 'João (grupo)'); assert.equal(m[0].body, 'oi galera');
});

test('(2) dedup por external_message_id (não duplica)', async () => {
  await engine.captureGroupInbound(T1, JID, { externalMessageId: 'G1', sender: 'João', body: 'oi galera' }, {});
  const cv = await conv();
  assert.equal((await msgs(cv.id)).length, 1, 'mesma msg não duplica');
  // uma mensagem NOVA no mesmo grupo entra
  await engine.captureGroupInbound(T1, JID, { externalMessageId: 'G2', sender: 'Maria', body: 'bom dia' }, {});
  assert.equal((await msgs(cv.id)).length, 2);
});

test('(3) jid que não é grupo (@s.whatsapp.net) é ignorado', async () => {
  await engine.captureGroupInbound(T1, '5519999999999@s.whatsapp.net', { externalMessageId: 'X1', sender: 'A', body: 'oi' }, {});
  const r = await c.query(`SELECT count(*)::int n FROM conversations WHERE external_id LIKE '%@s.whatsapp.net'`);
  assert.equal(r.rows[0].n, 0, 'não cria conversa p/ jid não-grupo');
});
