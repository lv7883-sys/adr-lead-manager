'use strict';
// inbox-acoes.itest.js — ADR-042 / Fase 1.5: reagir (#2), anexar mídia (#3), marcar como lead (#5).
// Externo (Evolution/creds/saveBuffer) MOCKADO; resolvers/persistência REAIS contra o banco.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const inbox = require('../src/routes/inbox');

let c;
const T1 = '00000000-0000-0000-0000-0000000000c9';

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`
    CREATE TABLE conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, channel text, external_id text);
    CREATE TABLE messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, role text, sender text,
      external_message_id text, raw jsonb, received_at timestamptz DEFAULT now());
    CREATE TABLE staff_outbound_samples (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, channel text,
      external_id text, external_message_id text, source text, sender text, body text, raw jsonb,
      media_url text, media_type text, media_filename text, reply_to_message_id uuid,
      deleted_at timestamptz, received_at timestamptz DEFAULT now());
    CREATE UNIQUE INDEX so_uq ON staff_outbound_samples (tenant_id, external_message_id) WHERE external_message_id IS NOT NULL;
    CREATE TABLE pending_approvals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, suggested_response text, status text, received_at timestamptz DEFAULT now());
    CREATE TABLE leads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, name text, phone text, meta_psid text,
      status text, review_queue boolean, review_result text, review_em timestamptz, review_by text, origem text,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
  `);
});
after(async () => { await c.end(); });

const conv = async (ext, channel = 'whatsapp') => (await c.query(
  `INSERT INTO conversations (tenant_id, channel, external_id) VALUES ($1,$2,$3) RETURNING id`, [T1, channel, ext])).rows[0].id;

// ---- #2 REAGIR -------------------------------------------------------------
test('(react-1) reage a bolha NOSSA (outbound) — resolve via resolverKeyMensagem', async () => {
  const mid = (await c.query(
    `INSERT INTO staff_outbound_samples (tenant_id, external_id, external_message_id, body) VALUES ($1,'+5519999990001','WAOUT1','oi') RETURNING id`, [T1])).rows[0].id;
  let sent = 0;
  const deps = { evolution: { sendReaction: async () => { sent++; return { ok: true }; } }, credsForTenant: async () => ({ instance: 'i', apikey: 'k' }) };
  const out = await inbox.reactToMessage(T1, mid, '👍', deps);
  assert.equal(out.ok, true); assert.equal(sent, 1);
});

test('(react-2) reage a bolha INBOUND (mensagem do cliente) — key do raw do webhook', async () => {
  const cv = await conv('+5519999990002');
  const mid = (await c.query(
    `INSERT INTO messages (conversation_id, role, external_message_id, raw) VALUES ($1,'USER','WAIN1',$2) RETURNING id`,
    [cv, JSON.stringify({ data: { key: { id: 'WAIN1', remoteJid: '5519999990002@s.whatsapp.net', fromMe: false } } })])).rows[0].id;
  let sent = 0;
  const deps = { evolution: { sendReaction: async () => { sent++; return { ok: true }; } }, credsForTenant: async () => ({ instance: 'i', apikey: 'k' }) };
  const out = await inbox.reactToMessage(T1, mid, '❤️', deps);
  assert.equal(out.ok, true); assert.equal(sent, 1);
});

test('(react-3) mid inexistente → notFound', async () => {
  const deps = { evolution: { sendReaction: async () => ({ ok: true }) }, credsForTenant: async () => ({ instance: 'i', apikey: 'k' }) };
  assert.deepEqual(await inbox.reactToMessage(T1, '00000000-0000-0000-0000-0000000000ff', '👍', deps), { notFound: true });
});

// ---- #3 ANEXAR MÍDIA -------------------------------------------------------
test('(midia-1) happy-path: envia e persiste a saída de mídia', async () => {
  const cv = await conv('+5519999990003');
  const deps = {
    evolution: { status: async () => ({ state: 'open' }), sendMedia: async () => ({ key: { id: 'WAMED1' } }), pickMessageId: () => 'WAMED1' },
    credsForTenant: async () => ({ instance: 'i', apikey: 'k' }),
    saveBuffer: () => ({ media_type: 'image', base64: 'BASE64', media_url: '/media/x.jpg' }),
  };
  const out = await inbox.sendInboxMedia(T1, cv, { buffer: Buffer.from('x'), mimetype: 'image/jpeg', originalname: 'x.jpg' }, 'olha isso', 'RECEPCAO', deps);
  assert.equal(out.ok, true); assert.equal(out.media_type, 'image');
  const row = (await c.query(`SELECT * FROM staff_outbound_samples WHERE external_message_id='WAMED1'`)).rows[0];
  assert.ok(row); assert.equal(row.body, 'olha isso'); assert.equal(row.media_type, 'image'); assert.equal(row.source, 'api');
});

test('(midia-2) canal não suportado → unsupported', async () => {
  const cv = await conv('+5519999990004', 'instagram_dm');
  const deps = { evolution: { status: async () => ({ state: 'open' }) }, credsForTenant: async () => ({ instance: 'i', apikey: 'k' }), saveBuffer: () => ({}) };
  assert.deepEqual(await inbox.sendInboxMedia(T1, cv, { buffer: Buffer.from('x'), mimetype: 'image/jpeg', originalname: 'x.jpg' }, '', 'RECEPCAO', deps), { unsupported: 'instagram_dm' });
});

// ---- #5 MARCAR COMO LEAD ---------------------------------------------------
test('(lead-1) promove lead casável (NOT_LEAD) → QUALIFYING + confirmed_lead', async () => {
  const cv = await conv('+5519999990005');
  const leadId = (await c.query(`INSERT INTO leads (tenant_id, phone, status) VALUES ($1,'5519999990005','NOT_LEAD') RETURNING id`, [T1])).rows[0].id;
  const out = await inbox.marcarComoLead(T1, cv, 'RECEPCAO');
  assert.equal(out.ok, true); assert.equal(out.created, false); assert.equal(out.lead_id, leadId);
  const l = (await c.query('SELECT status, review_result FROM leads WHERE id=$1', [leadId])).rows[0];
  assert.equal(l.status, 'QUALIFYING'); assert.equal(l.review_result, 'confirmed_lead');
});

test('(lead-2) conversa sem lead → cria lead QUALIFYING', async () => {
  const cv = await conv('+5519999990006');
  await c.query(`INSERT INTO messages (conversation_id, role, sender) VALUES ($1,'USER','Maria')`, [cv]);
  const out = await inbox.marcarComoLead(T1, cv, 'RECEPCAO');
  assert.equal(out.ok, true); assert.equal(out.created, true);
  const l = (await c.query('SELECT name, phone, status, origem FROM leads WHERE id=$1', [out.lead_id])).rows[0];
  assert.equal(l.status, 'QUALIFYING'); assert.equal(l.name, 'Maria'); assert.equal(l.origem, 'whatsapp');
});

test('(lead-3) conversa inexistente → notFound', async () => {
  assert.deepEqual(await inbox.marcarComoLead(T1, '00000000-0000-0000-0000-0000000000ff', 'RECEPCAO'), { notFound: true });
});
