'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const app = require('../src/server');
const { pool, withTenant } = require('../src/db');

const TENANT_ID = crypto.randomUUID();
const ZAPI_TOKEN = 'tok-staff-test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sql, params) => withTenant(TENANT_ID, (c) => c.query(sql, params)).then((r) => r.rows);

let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await withTenant(TENANT_ID, (c) =>
    c.query(
      `INSERT INTO tenants (id, name, lead_manager_active, zapi_token)
       VALUES ($1, 'Staff Test', true, $2)`,
      [TENANT_ID, ZAPI_TOKEN]
    )
  );
});

after(async () => {
  await withTenant(TENANT_ID, (c) => c.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]));
  await new Promise((r) => server.close(r));
  await pool.end();
});

test('captura mensagem fromMe da recepção (staff sample) e NÃO cria lead', async () => {
  const res = await fetch(`${baseUrl}/webhook/zapi/${TENANT_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-ZAPI-TOKEN': ZAPI_TOKEN },
    body: JSON.stringify({
      event: 'messages.upsert',
      data: {
        key: { remoteJid: '5519990001234@s.whatsapp.net', fromMe: true, id: 'staff-1' },
        pushName: 'Késsia',
        source: 'android',
        message: { conversation: 'Olá! Aqui é a Késsia da Academia do Rock Valinhos.' },
      },
    }),
  });
  assert.equal(res.status, 200);

  // Captura é assíncrona (fire-and-forget após o ACK) — aguarda aparecer.
  let rows = [];
  for (let i = 0; i < 25 && rows.length === 0; i += 1) {
    await sleep(150);
    rows = await q("SELECT body, source, sender FROM staff_outbound_samples WHERE external_message_id = 'staff-1'");
  }
  assert.equal(rows.length, 1, 'amostra de outbound capturada');
  assert.match(rows[0].body, /Késsia/);
  assert.equal(rows[0].source, 'android');
  assert.equal(rows[0].sender, 'Késsia');

  // fromMe nunca vira lead.
  const leads = await q('SELECT 1 FROM leads WHERE tenant_id = $1', [TENANT_ID]);
  assert.equal(leads.length, 0, 'fromMe não cria lead');
});

test('reentrega da mesma mensagem não duplica a amostra (idempotência)', async () => {
  await fetch(`${baseUrl}/webhook/zapi/${TENANT_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-ZAPI-TOKEN': ZAPI_TOKEN },
    body: JSON.stringify({
      event: 'messages.upsert',
      data: {
        key: { remoteJid: '5519990001234@s.whatsapp.net', fromMe: true, id: 'staff-1' },
        pushName: 'Késsia',
        source: 'android',
        message: { conversation: 'Olá! Aqui é a Késsia da Academia do Rock Valinhos.' },
      },
    }),
  });
  await sleep(800);
  const rows = await q("SELECT 1 FROM staff_outbound_samples WHERE external_message_id = 'staff-1'");
  assert.equal(rows.length, 1, 'continua 1 amostra');
});
