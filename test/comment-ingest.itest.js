'use strict';
// comment-ingest.itest.js — engine.captureComment contra Postgres real: cria conversa
// kind='COMMENT' + message, dedup por external_message_id, e o CHECK aceita 'COMMENT'.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const engine = require('../src/engine');

let c;
const T1 = '00000000-0000-0000-0000-0000000000ab';

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`
    CREATE TABLE tenants (id uuid PRIMARY KEY, name text);
    CREATE TABLE conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, channel text NOT NULL DEFAULT 'whatsapp',
      external_id text NOT NULL, conversation_kind text NOT NULL DEFAULT 'DIRECT'
        CHECK (conversation_kind IN ('DIRECT','GROUP','COMMUNITY','COMMENT')),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, channel, external_id));
    CREATE TABLE messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, conversation_id uuid,
      direction text NOT NULL DEFAULT 'inbound', role text, external_message_id text, sender text,
      body text, raw jsonb NOT NULL DEFAULT '{}', received_at timestamptz NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX uq_msg_extid ON messages (tenant_id, external_message_id) WHERE external_message_id IS NOT NULL;
  `);
  await c.query(`INSERT INTO tenants (id,name) VALUES ($1,'ADR')`, [T1]);
});
after(async () => { await c.end(); });

async function msgs(convId) {
  return (await c.query(`SELECT external_message_id, role, sender, body, raw FROM messages WHERE conversation_id=$1 ORDER BY received_at`, [convId])).rows;
}

test('(1) captura comentário -> conversa kind=COMMENT + message role=USER', async () => {
  const cid = await engine.captureComment(T1, {
    channel: 'facebook_comment', externalId: 'U1', commentId: 'C1', sender: 'Maria', body: 'Tem aula de bateria?',
  }, { post_id: 'P1', parent_id: 'P1' });
  assert.ok(cid, 'retorna conversation_id');
  const cv = (await c.query(`SELECT channel, conversation_kind, external_id FROM conversations WHERE id=$1`, [cid])).rows[0];
  assert.equal(cv.channel, 'facebook_comment');
  assert.equal(cv.conversation_kind, 'COMMENT');
  assert.equal(cv.external_id, 'U1');
  const rows = await msgs(cid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].external_message_id, 'C1');
  assert.equal(rows[0].role, 'USER');
  assert.equal(rows[0].sender, 'Maria');
  assert.equal(rows[0].body, 'Tem aula de bateria?');
  assert.equal(rows[0].raw.post_id, 'P1');
});

test('(2) dedup: mesmo comment_id (reentrega) não duplica', async () => {
  const cid = await engine.captureComment(T1, { channel: 'instagram_comment', externalId: 'U2', commentId: 'C2', sender: 'ana', body: 'valor?' }, {});
  await engine.captureComment(T1, { channel: 'instagram_comment', externalId: 'U2', commentId: 'C2', sender: 'ana', body: 'valor?' }, {});
  assert.equal((await msgs(cid)).length, 1);
});

test('(3) 2 comentários do mesmo autor -> mesma conversa, 2 mensagens', async () => {
  const a = await engine.captureComment(T1, { channel: 'facebook_comment', externalId: 'U3', commentId: 'C3a', sender: 'Zé', body: 'oi' }, {});
  const b = await engine.captureComment(T1, { channel: 'facebook_comment', externalId: 'U3', commentId: 'C3b', sender: 'Zé', body: 'e o preço?' }, {});
  assert.equal(a, b, 'mesma conversa (upsert por tenant+channel+external_id)');
  assert.equal((await msgs(a)).length, 2);
});

test('(4) args incompletos -> null (sem gravar)', async () => {
  assert.equal(await engine.captureComment(T1, { channel: 'facebook_comment', externalId: 'U9', commentId: null, body: 'x' }, {}), null);
  assert.equal(await engine.captureComment(T1, { channel: 'facebook_comment', externalId: null, commentId: 'C9', body: 'x' }, {}), null);
});

test('(5) CHECK aceita COMMENT e rejeita valor inválido', async () => {
  await c.query(`INSERT INTO conversations (tenant_id, channel, external_id, conversation_kind) VALUES ($1,'x','ok-comment','COMMENT')`, [T1]);
  await assert.rejects(
    c.query(`INSERT INTO conversations (tenant_id, channel, external_id, conversation_kind) VALUES ($1,'x','bogus','BOGUS')`, [T1]),
    /conversation_kind/);
});
