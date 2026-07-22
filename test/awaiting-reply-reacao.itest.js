'use strict';
// awaiting-reply-reacao.itest.js — CINTO do #3: reação (emoji) inbound NÃO conta como turno do
// cliente na contabilidade do awaiting_reply (fallback por timestamp). PG descartável, schema
// mínimo. Testa a EXPRESSÃO real (espelho do tenant.js:680-694, com o filtro de reação).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

let c;
// Expressão awaiting_reply (fixada) — espelho fiel do tenant.js. `l` = lead na FROM.
const AWAITING = `
  (l.status <> 'EXPERIMENTAL_AGENDADA' AND l.status <> 'CONVERTED' AND l.desfecho IS NULL AND (
    (l.conversation_state = 'AGUARDANDO_RECEPCAO' AND l.state_computed_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM staff_outbound_samples s
                       WHERE regexp_replace(s.external_id,'[^0-9]','','g')=regexp_replace(coalesce(l.phone,l.meta_psid,''),'[^0-9]','','g')
                         AND s.received_at > l.state_computed_at))
    OR ((l.conversation_state IS NULL OR (l.conversation_state='AGUARDANDO_RECEPCAO' AND l.state_computed_at IS NULL)) AND
        (SELECT max(m.received_at) FROM messages m JOIN conversations cv ON cv.id=m.conversation_id
          WHERE cv.external_id=l.phone AND m.role='USER' AND coalesce(m.body,'') NOT LIKE '[reação]%')
        > COALESCE((SELECT max(s.received_at) FROM staff_outbound_samples s
          WHERE regexp_replace(s.external_id,'[^0-9]','','g')=regexp_replace(coalesce(l.phone,l.meta_psid,''),'[^0-9]','','g')),'epoch'::timestamptz))
  ))`;
const awaiting = async (phone) => (await c.query(
  `SELECT ${AWAITING} AS aw FROM leads l WHERE l.phone=$1`, [phone])).rows[0].aw;

// helpers de seed
async function lead(phone, over = {}) {
  const o = { status: 'QUALIFYING', conversation_state: null, state_computed_at: null, desfecho: null, ...over };
  const id = (await c.query(`INSERT INTO leads (phone, status, conversation_state, state_computed_at, desfecho) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [phone, o.status, o.conversation_state, o.state_computed_at, o.desfecho])).rows[0].id;
  await c.query(`INSERT INTO conversations (external_id) VALUES ($1) ON CONFLICT DO NOTHING`, [phone]);
  return id;
}
const msg = (phone, body, at) => c.query(
  `INSERT INTO messages (conversation_id, role, body, received_at) SELECT id,'USER',$2,$3 FROM conversations WHERE external_id=$1`, [phone, body, at]);
const out = (phone, at) => c.query(`INSERT INTO staff_outbound_samples (external_id, received_at) VALUES ($1,$2)`, [phone, at]);

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  await c.query(`
    CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), external_id text UNIQUE);
    CREATE TABLE leads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), phone text, meta_psid text,
      status text, conversation_state text, state_computed_at timestamptz, desfecho text);
    CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, role text, body text, received_at timestamptz);
    CREATE TABLE staff_outbound_samples (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), external_id text, received_at timestamptz);`);
});
after(async () => { await c.end(); });

const T = (h) => `2026-07-10 ${h}:00`;

test('(a) reação inbound APÓS nossa saída → awaiting_reply FALSE (não reabre)', async () => {
  const p = '111';
  await lead(p);
  await msg(p, 'Oi, quero saber dos planos', T('10')); // turno real do lead
  await out(p, T('11'));                                // nossa saída (respondemos)
  await msg(p, '[reação] 👍', T('12'));                 // reação DEPOIS → NÃO conta
  assert.equal(await awaiting(p), false);
});

test('(b) mensagem REAL (texto) após nossa saída → awaiting_reply TRUE (normal preservado)', async () => {
  const p = '222';
  await lead(p);
  await msg(p, 'Oi', T('10'));
  await out(p, T('11'));
  await msg(p, 'Consigo começar semana que vem?', T('12')); // texto real → conta
  assert.equal(await awaiting(p), true);
});

test('(c) Alessandra: 3 reações após a apresentação → NÃO devemos resposta', async () => {
  const p = '333';
  await lead(p);
  await msg(p, 'Vocês têm aula pra adultos?', T('10'));
  await out(p, T('11'));                                 // apresentação/PDF
  await msg(p, '[reação] 🙏🏻', T('12'));
  await msg(p, '[reação] 👍🏻', T('13'));
  await msg(p, '[reação] 🙏🏻', T('14'));
  assert.equal(await awaiting(p), false);
});

test('(d) conversation_state NÃO-NULL (AGUARDANDO_CLIENTE) → inalterado (fora do fallback)', async () => {
  const p = '444';
  await lead(p, { conversation_state: 'AGUARDANDO_CLIENTE', state_computed_at: T('11') });
  await out(p, T('11'));
  await msg(p, '[reação] 👍', T('12'));   // mesmo com reação, o estado governa → não entra no fallback
  assert.equal(await awaiting(p), false);
});

test('(e) mídia (body NULL) após nossa saída → conta como turno (não é reação) → TRUE', async () => {
  const p = '555';
  await lead(p);
  await out(p, T('11'));
  await msg(p, null, T('12'));   // imagem/áudio: body NULL, mas é mensagem real
  assert.equal(await awaiting(p), true);
});
