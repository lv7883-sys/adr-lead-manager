'use strict';
// wa-chats.itest.js — o que se faz na LISTA de conversas do celular/WhatsApp Web vale no Regente (15/09/2026):
// marcar como não lida / lida, arquivar, fixar e silenciar (chats.update completo, Evolution corrigida). PG descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const waChats = require('../src/waChats');
const inbox = require('../src/routes/inbox');

let c;
const T1 = '00000000-0000-0000-0000-0000000000c9';
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
    CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, channel text DEFAULT 'whatsapp', external_id text,
      conversation_kind text DEFAULT 'DIRECT', last_read_at timestamptz, last_activity_at timestamptz DEFAULT now(),
      arquivada_em timestamptz, fixada_em timestamptz, silenciada_ate timestamptz,
      br_key text GENERATED ALWAYS AS (br_phone_key(external_id)) STORED);
    CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, conversation_id uuid, role text, body text,
      raw jsonb, external_message_id text, received_at timestamptz DEFAULT now());
    CREATE TABLE wa_lid (tenant_id uuid, lid text, pn text, proprio boolean DEFAULT false, PRIMARY KEY (tenant_id, lid));
  `);
});
after(async () => { await c.end(); });

async function conversa(ext, kind = 'DIRECT') {
  const id = (await c.query('INSERT INTO conversations (tenant_id, external_id, conversation_kind) VALUES ($1,$2,$3) RETURNING id', [T1, ext, kind])).rows[0].id;
  await c.query("INSERT INTO messages (tenant_id, conversation_id, role, body, received_at) VALUES ($1,$2,'USER','oi', now() - interval '5 minutes')", [T1, id]);
  return id;
}
const cv = async (id) => (await c.query('SELECT * FROM conversations WHERE id=$1', [id])).rows[0];

test('(1) celular marca como NÃO lida -> não lida no Regente; marca como lida -> lida', async () => {
  const id = await conversa('5519999990001');
  await inbox.markRead(c, T1, id, null);
  const r = await waChats.aplicarChatsUpdate(T1, [{ id: '5519999990001@s.whatsapp.net', unreadCount: -1 }], { withTenant: run });
  assert.deepEqual(r[0].acoes, ['nao_lida']);
  const n = (await c.query("SELECT count(*)::int n FROM messages WHERE conversation_id=$1 AND received_at > (SELECT last_read_at FROM conversations WHERE id=$1)", [id])).rows[0].n;
  assert.equal(n, 1, 'voltou a ter não lida');
  await waChats.aplicarChatsUpdate(T1, [{ id: '5519999990001@s.whatsapp.net', unreadCount: 0 }], { withTenant: run });
  assert.ok(new Date((await cv(id)).last_read_at) > new Date(Date.now() - 60000), 'lida');
});

test('(2) mensagem nova (unreadCount positivo) e atualização sem campo de estado são ignoradas', async () => {
  const id = await conversa('5519999990002');
  await inbox.markRead(c, T1, id, null);
  const antes = (await cv(id)).last_read_at;
  const r = await waChats.aplicarChatsUpdate(T1, [{ id: '5519999990002@s.whatsapp.net', unreadCount: 3 }, { id: '5519999990002@s.whatsapp.net', conversationTimestamp: 1 }], { withTenant: run });
  assert.equal(r.length, 0);
  assert.equal(String((await cv(id)).last_read_at), String(antes));
});

test('(3) arquivar, fixar e silenciar (e desfazer) — também por @lid e em grupo', async () => {
  const id = await conversa('5519988887777');
  await c.query("INSERT INTO wa_lid (tenant_id, lid, pn) VALUES ($1,'555@lid','5519988887777@s.whatsapp.net')", [T1]);
  await waChats.aplicarChatsUpdate(T1, [{ id: '555@lid', archived: true, pinned: 1757950000000, muteEndTime: -1 }], { withTenant: run });
  let x = await cv(id);
  assert.ok(x.arquivada_em); assert.ok(x.fixada_em); assert.equal(String(x.silenciada_ate), 'Infinity');
  await waChats.aplicarChatsUpdate(T1, [{ id: '555@lid', archived: false, pinned: null, muteEndTime: null }], { withTenant: run });
  x = await cv(id);
  assert.equal(x.arquivada_em, null); assert.equal(x.fixada_em, null); assert.equal(x.silenciada_ate, null);
  const g = await conversa('120363000000000099@g.us', 'GROUP');
  await waChats.aplicarChatsUpdate(T1, { id: '120363000000000099@g.us', archived: true }, { withTenant: run });
  assert.ok((await cv(g)).arquivada_em);
});

test('(4) conversa que o Regente não tem -> nada acontece; roteador só pega chats.update', async () => {
  const r = await waChats.aplicarChatsUpdate(T1, [{ id: '5511000000000@s.whatsapp.net', archived: true }], { withTenant: run });
  assert.equal(r[0].resultado, 'sem_conversa');
  assert.equal(waChats.tratarEvento(T1, { event: 'messages.upsert', data: {} }), false);
});
