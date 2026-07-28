'use strict';
// inbox-edit.itest.js — ADR-042 / E12-07: editar e apagar mensagem NOSSA na thread do inbox.
// Evolution MOCKADA (deps); resolverKeyMensagem REAL (SQL contra o banco). Cobre: apagar
// (ok+persist / idempotente / notFound / falha Evolution) e editar (ok+persist original_body /
// bolha IA via pending_approvals). Conecta como postgres (sem RLS), schema mínimo.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const inbox = require('../src/routes/inbox');

let c;
const T1 = '00000000-0000-0000-0000-0000000000b7';

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query(`
    CREATE TABLE staff_outbound_samples (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, external_id text,
      external_message_id text, body text, original_body text,
      deleted_at timestamptz, edited_at timestamptz, received_at timestamptz DEFAULT now(), raw jsonb);
    CREATE TABLE pending_approvals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, suggested_response text,
      status text, received_at timestamptz DEFAULT now());
  `);
});
after(async () => { await c.end(); });

async function outbound(o = {}) {
  return (await c.query(
    `INSERT INTO staff_outbound_samples (tenant_id, external_id, external_message_id, body, deleted_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [T1, o.extId || '+5519999990001', o.extMsgId || 'WAMSG1', o.body ?? 'ola', o.deleted_at || null])).rows[0].id;
}
async function pending(o = {}) {
  return (await c.query(
    `INSERT INTO pending_approvals (tenant_id, suggested_response, status) VALUES ($1,$2,$3) RETURNING id`,
    [T1, o.body ?? 'resposta IA', o.status || 'APPROVED'])).rows[0].id;
}
function mkDeps({ del = true, ed = true, creds = { instance: 'i', apikey: 'k' } } = {}) {
  const spy = { dels: 0, eds: 0 };
  const evolution = {
    deleteMessage: async () => { spy.dels++; return { ok: del, error: del ? null : 'janela expirada' }; },
    editMessage: async () => { spy.eds++; return { ok: ed, error: ed ? null : 'janela expirada' }; },
  };
  return { deps: { evolution, credsForTenant: async () => creds }, spy };
}
const row = async (id) => (await c.query('SELECT * FROM staff_outbound_samples WHERE id=$1', [id])).rows[0];

// =============================================================================
test('(1) apagar bolha da recepcao: ok + persiste deleted_at + chama Evolution', async () => {
  const mid = await outbound({ body: 'oi' });
  const { deps, spy } = mkDeps();
  const out = await inbox.deleteInboxMessage(T1, mid, deps);
  assert.equal(out.ok, true);
  assert.equal(spy.dels, 1);
  assert.ok((await row(mid)).deleted_at, 'deleted_at setado');
});

test('(2) apagar idempotente: ja_apagada, sem chamar Evolution', async () => {
  const mid = await outbound({ deleted_at: new Date().toISOString() });
  const { deps, spy } = mkDeps();
  const out = await inbox.deleteInboxMessage(T1, mid, deps);
  assert.equal(out.ja_apagada, true);
  assert.equal(spy.dels, 0);
});

test('(3) apagar mid inexistente (ou bolha do lead): notFound, sem Evolution', async () => {
  const { deps, spy } = mkDeps();
  const out = await inbox.deleteInboxMessage(T1, '00000000-0000-0000-0000-0000000000ff', deps);
  assert.deepEqual(out, { notFound: true });
  assert.equal(spy.dels, 0);
});

test('(4) apagar com falha da Evolution: reason, NAO seta deleted_at', async () => {
  const mid = await outbound();
  const { deps } = mkDeps({ del: false });
  const out = await inbox.deleteInboxMessage(T1, mid, deps);
  assert.equal(out.reason, 'nao_apagou');
  assert.equal((await row(mid)).deleted_at, null, 'nao apagou no banco');
});

test('(5) editar bolha da recepcao: persiste body novo + original_body + edited_at', async () => {
  const mid = await outbound({ body: 'texto original' });
  const { deps, spy } = mkDeps();
  const out = await inbox.editInboxMessage(T1, mid, 'texto editado', deps);
  assert.equal(out.ok, true);
  assert.equal(spy.eds, 1);
  const r = await row(mid);
  assert.equal(r.body, 'texto editado');
  assert.equal(r.original_body, 'texto original');
  assert.ok(r.edited_at);
});

test('(6) editar bolha IA (via pending_approvals): atualiza saida E suggested_response', async () => {
  const paId = await pending({ body: 'resposta IA', status: 'APPROVED' });
  const soId = await outbound({ body: 'resposta IA' });   // eco da IA em staff_outbound
  const { deps } = mkDeps();
  const out = await inbox.editInboxMessage(T1, paId, 'resposta IA corrigida', deps);
  assert.equal(out.ok, true);
  assert.equal((await row(soId)).body, 'resposta IA corrigida', 'eco atualizado');
  const pa = (await c.query('SELECT suggested_response FROM pending_approvals WHERE id=$1', [paId])).rows[0];
  assert.equal(pa.suggested_response, 'resposta IA corrigida', 'pending atualizado (dedup da timeline)');
});
