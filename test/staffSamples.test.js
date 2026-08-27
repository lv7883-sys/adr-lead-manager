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

// ---- RASCUNHO OBSOLETO (regra do Leo, 2026-08-27) ---------------------------------------------
// A recepção responder com o texto DELA torna o rascunho da IA obsoleto na hora. Antes isso
// dependia de uma varredura periódica que nunca foi ligada, e o selo "Rascunho pronto" aparecia
// em quase todo card do Kanban.
async function _semearRascunho({ fone, msgId, criadoEm = 'now()' }) {
  return withTenant(TENANT_ID, async (c) => {
    const conv = (await c.query(
      `INSERT INTO conversations (tenant_id, channel, external_id) VALUES ($1,'whatsapp',$2) RETURNING id`,
      [TENANT_ID, fone])).rows[0];
    const lead = (await c.query(
      `INSERT INTO leads (tenant_id, status, phone) VALUES ($1,'QUALIFYING',$2) RETURNING id`,
      [TENANT_ID, fone])).rows[0];
    const pa = (await c.query(
      `INSERT INTO pending_approvals (tenant_id, lead_id, conversation_id, suggested_response, status, created_at)
       VALUES ($1,$2,$3,'rascunho da IA','PENDING', ${criadoEm}) RETURNING id`,
      [TENANT_ID, lead.id, conv.id])).rows[0];
    return { convId: conv.id, paId: pa.id, msgId };
  });
}
const _statusDo = async (paId) =>
  (await q('SELECT status FROM pending_approvals WHERE id = $1', [paId]))[0].status;

const _ecoHumano = (fone, id, source = 'web') => fetch(`${baseUrl}/webhook/zapi/${TENANT_ID}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ZAPI-TOKEN': ZAPI_TOKEN },
  body: JSON.stringify({ event: 'messages.upsert', data: {
    key: { remoteJid: `${fone}@s.whatsapp.net`, fromMe: true, id }, pushName: 'Késsia',
    source, message: { conversation: 'Respondi do meu jeito, oi!' } } }),
});

test('resposta HUMANA arquiva o rascunho pendente daquela conversa', async () => {
  const { paId } = await _semearRascunho({ fone: '5519990007777', msgId: 'staff-arq-1' });
  assert.equal(await _statusDo(paId), 'PENDING');
  await _ecoHumano('5519990007777', 'staff-arq-1');
  let st = 'PENDING';
  for (let i = 0; i < 25 && st === 'PENDING'; i += 1) { await sleep(150); st = await _statusDo(paId); }
  assert.equal(st, 'ARCHIVED', 'o rascunho perde a validade quando a recepção responde');
});

test('envio AUTOMÁTICO não arquiva — NPS/campanha não significam que alguém cuidou do lead', async () => {
  const { paId } = await _semearRascunho({ fone: '5519990008888', msgId: 'staff-arq-2' });
  await _ecoHumano('5519990008888', 'staff-arq-2', 'unknown');   // source não-humano
  await sleep(900);
  assert.equal(await _statusDo(paId), 'PENDING', 'só saída de device humano arquiva');
});

test('rascunho criado DEPOIS da resposta sobrevive (eco fora de ordem)', async () => {
  // O rascunho é do futuro em relação ao eco → é legítimo e não pode ser arquivado por ele.
  const { paId } = await _semearRascunho({ fone: '5519990009999', msgId: 'staff-arq-3', criadoEm: "now() + interval '1 hour'" });
  await _ecoHumano('5519990009999', 'staff-arq-3');
  await sleep(900);
  assert.equal(await _statusDo(paId), 'PENDING', 'só arquiva rascunho ANTERIOR à resposta');
});
