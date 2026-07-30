'use strict';
// inbox-send.itest.js — ADR-042 / E12-06: envio humano na conversa (via Z-API/Evolution).
// A API externa (Evolution) e as credenciais sao MOCKADAS (deps injetadas) — NAO dispara
// WhatsApp. O outbound.registrarSaida REAL grava em staff_outbound_samples (mesmo DB), entao
// asseguramos a persistencia. Cobre: happy-path; 404; canal nao suportado; sem-evolution;
// instancia fechada — e que a API externa NAO e chamada nos casos de erro.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const inbox = require('../src/routes/inbox');

let c;
const T1 = '00000000-0000-0000-0000-0000000000a1';

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`
    CREATE TABLE conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, channel text, external_id text);
    CREATE TABLE staff_outbound_samples (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, channel text, external_id text,
      external_message_id text, source text, sender text, body text, raw jsonb,
      media_url text, media_type text, media_filename text, reply_to_message_id uuid);
    CREATE UNIQUE INDEX so_uq ON staff_outbound_samples (tenant_id, external_message_id) WHERE external_message_id IS NOT NULL;
  `);
});
after(async () => { await c.end(); });

const H = (n) => `+5519${String(n).padStart(9, '0')}`;
async function conv(tenant, ext, channel = 'whatsapp') {
  return (await c.query(`INSERT INTO conversations (tenant_id, channel, external_id) VALUES ($1,$2,$3) RETURNING id`, [tenant, channel, ext])).rows[0].id;
}
// Evolution + Meta mockadas com espião de envio. Creds mockadas (sem tocar tenants/crypto).
function mkDeps({ state = 'open', creds = { instance: 'inst', apikey: 'key' }, metaCreds = { pageId: 'PID', token: 'TOK' } } = {}) {
  const spy = { sends: 0, metaSends: 0 };
  const evolution = {
    status: async () => ({ state }),
    sendText: async () => { spy.sends++; return { key: { id: 'MSGID1' } }; },
    pickMessageId: () => 'MSGID1',
  };
  const meta = { sendMessage: async () => { spy.metaSends++; return { message_id: 'MMSG1' }; } };
  return { deps: { evolution, credsForTenant: async () => creds, meta, pageCredsForTenant: async () => metaCreds }, spy };
}
const soRows = async (tenant) => (await c.query('SELECT * FROM staff_outbound_samples WHERE tenant_id=$1', [tenant])).rows;

// =============================================================================
test('(1) happy-path: envia e persiste a saida (source=api, channel=whatsapp)', async () => {
  const cv = await conv(T1, H(1));
  const { deps, spy } = mkDeps();
  const out = await inbox.sendMessage(T1, cv, { text: 'ola tudo bem?', sender: 'RECEPCAO' }, deps);
  assert.equal(out.ok, true);
  assert.equal(out.message_id, 'MSGID1');
  assert.equal(spy.sends, 1, 'chamou o envio externo uma vez');
  const rows = await soRows(T1);
  const row = rows.find((r) => r.external_message_id === 'MSGID1');
  assert.ok(row, 'gravou em staff_outbound_samples');
  assert.equal(row.body, 'ola tudo bem?');
  assert.equal(row.external_id, H(1));
  assert.equal(row.source, 'api');
  assert.equal(row.channel, 'whatsapp');
  assert.equal(row.sender, 'RECEPCAO');
});

test('(2) conversa inexistente -> notFound, sem chamar a API externa', async () => {
  const { deps, spy } = mkDeps();
  const out = await inbox.sendMessage(T1, '00000000-0000-0000-0000-0000000000ff', { text: 'oi' }, deps);
  assert.deepEqual(out, { notFound: true });
  assert.equal(spy.sends, 0);
});

test('(3) canal nao suportado (ex.: google) -> unsupported, sem envio', async () => {
  const cv = await conv(T1, H(3), 'google');
  const { deps, spy } = mkDeps();
  const out = await inbox.sendMessage(T1, cv, { text: 'oi' }, deps);
  assert.deepEqual(out, { unsupported: 'google' });
  assert.equal(spy.sends, 0); assert.equal(spy.metaSends, 0);
});

test('(3b) Instagram DM -> envia via Meta (PSID) e persiste a saida', async () => {
  const cv = await conv(T1, '17841400000000001', 'instagram_dm');
  const { deps, spy } = mkDeps();
  const out = await inbox.sendMessage(T1, cv, { text: 'oi pelo insta', sender: 'RECEPCAO' }, deps);
  assert.equal(out.ok, true); assert.equal(out.channel, 'instagram_dm'); assert.equal(out.message_id, 'MMSG1');
  assert.equal(spy.metaSends, 1); assert.equal(spy.sends, 0, 'nao chamou Evolution');
  const row = (await soRows(T1)).find((r) => r.external_message_id === 'MMSG1');
  assert.ok(row); assert.equal(row.body, 'oi pelo insta'); assert.equal(row.external_id, '17841400000000001');
});

test('(3c) Messenger sem credenciais Meta -> tenant_sem_meta, sem envio', async () => {
  const cv = await conv(T1, '2000000000001', 'facebook_messenger');
  const { deps, spy } = mkDeps({ metaCreds: { pageId: null, token: null } });
  const out = await inbox.sendMessage(T1, cv, { text: 'oi' }, deps);
  assert.equal(out.reason, 'tenant_sem_meta'); assert.equal(spy.metaSends, 0);
});

test('(4) tenant sem evolution -> reason, sem envio', async () => {
  const cv = await conv(T1, H(4));
  const { deps, spy } = mkDeps({ creds: { instance: null, apikey: null } });
  const out = await inbox.sendMessage(T1, cv, { text: 'oi' }, deps);
  assert.equal(out.reason, 'tenant_sem_evolution');
  assert.equal(spy.sends, 0);
});

test('(5) instancia desconectada -> reason=instancia=..., sem envio', async () => {
  const cv = await conv(T1, H(5));
  const { deps, spy } = mkDeps({ state: 'close' });
  const out = await inbox.sendMessage(T1, cv, { text: 'oi' }, deps);
  assert.equal(out.reason, 'instancia=close');
  assert.equal(spy.sends, 0);
});
