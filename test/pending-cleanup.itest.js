'use strict';
// pending-cleanup.itest.js — Fatia D: dedup do Portão 2 + limpeza (migração 074).
// PG descartável, schema lead_manager (a 074 é schema-qualificada). NUNCA toca produção.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

let c;
const T1 = '00000000-0000-0000-0000-0000000000a1';
const T2 = '00000000-0000-0000-0000-0000000000a2';
const MIG074 = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '074_pending_approvals_cleanup.sql'), 'utf8');

// espelho FIEL do dedup do Portão 2 (engine.js): arquiva PENDING anterior, insere novo.
async function inbound(tenant, leadId) {
  await c.query(`UPDATE pending_approvals SET status='ARCHIVED' WHERE tenant_id=$1 AND lead_id=$2 AND status='PENDING'`, [tenant, leadId]);
  await c.query(`INSERT INTO pending_approvals (tenant_id, lead_id, suggested_response, status) VALUES ($1,$2,'rascunho','PENDING')`, [tenant, leadId]);
}
async function lead(tenant, status, desfecho = null) {
  return (await c.query(`INSERT INTO leads (tenant_id, status, desfecho) VALUES ($1,$2,$3) RETURNING id`, [tenant, status, desfecho])).rows[0].id;
}
// insere N PENDING "crus" (pré-fix) pro mesmo lead, com created_at espaçado
async function seedPending(tenant, leadId, n) {
  for (let i = 0; i < n; i++) {
    await c.query(`INSERT INTO pending_approvals (tenant_id, lead_id, suggested_response, status, created_at)
                   VALUES ($1,$2,$3,'PENDING', now() - make_interval(mins => $4))`, [tenant, leadId, 'r' + i, (n - i)]);
  }
}
const nPend = async (leadId) => (await c.query(`SELECT count(*)::int n FROM pending_approvals WHERE lead_id=$1 AND status='PENDING'`, [leadId])).rows[0].n;

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  await c.query(`CREATE SCHEMA lead_manager; SET search_path = lead_manager, public;`);
  await c.query(`
    CREATE TABLE leads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, status text, desfecho text);
    CREATE TABLE pending_approvals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, lead_id uuid,
      conversation_id uuid, suggested_response text, status text DEFAULT 'PENDING', created_at timestamptz DEFAULT now(),
      decided_at timestamptz, decided_by text, reply_to_message_id uuid);`);
});
after(async () => { await c.end(); });
const reset = () => c.query(`TRUNCATE leads, pending_approvals`);

test('(1) dedup Portão 2: 2 inbounds seguidos → 1 PENDING (não 2)', async () => {
  await reset();
  const id = await lead(T1, 'QUALIFYING');
  await inbound(T1, id);
  await inbound(T1, id);   // 2º inbound arquiva o 1º, insere o novo
  assert.equal(await nPend(id), 1, 'exatamente 1 PENDING após 2 inbounds');
  assert.equal((await c.query(`SELECT count(*)::int n FROM pending_approvals WHERE lead_id=$1 AND status='ARCHIVED'`, [id])).rows[0].n, 1, '1 arquivado');
});

test('(2) limpeza: N duplicados → 1 (o mais recente); órfão → 0', async () => {
  await reset();
  const vivo = await lead(T1, 'QUALIFYING');
  await seedPending(T1, vivo, 5);           // 5 duplicados (pré-fix)
  const orfao = await lead(T1, 'NOT_LEAD');
  await seedPending(T1, orfao, 3);          // órfão com 3
  assert.equal(await nPend(vivo), 5); assert.equal(await nPend(orfao), 3);
  await c.query(MIG074);
  assert.equal(await nPend(vivo), 1, 'vivo colapsa p/ 1 (mais recente)');
  assert.equal(await nPend(orfao), 0, 'órfão NOT_LEAD purgado');
});

test('(3) terminal por desfecho → purgado; PENDING vivo preservado', async () => {
  await reset();
  const matriculado = await lead(T1, 'QUALIFYING', 'matriculado');  // terminal por desfecho (Fatia A)
  await seedPending(T1, matriculado, 2);
  const vivo = await lead(T1, 'QUALIFIED');
  await seedPending(T1, vivo, 1);
  await c.query(MIG074);
  assert.equal(await nPend(matriculado), 0, 'terminal/desfecho purgado');
  assert.equal(await nPend(vivo), 1, 'vivo preservado');
});

test('(4) CUIDADO Aline: lead REABERTO (QUALIFYING, desfecho NULL) → PENDING preservado', async () => {
  await reset();
  const reaberto = await lead(T1, 'QUALIFYING', null);   // era NOT_LEAD, reaberto
  await seedPending(T1, reaberto, 4);
  await c.query(MIG074);
  assert.equal(await nPend(reaberto), 1, 'reaberto mantém 1 PENDING (não é órfão)');
});

test('(5) migração idempotente: rodar 2× não muda', async () => {
  await reset();
  const vivo = await lead(T1, 'QUALIFYING'); await seedPending(T1, vivo, 4);
  const orfao = await lead(T1, 'NOT_LEAD'); await seedPending(T1, orfao, 2);
  await c.query(MIG074);
  const a = await nPend(vivo), b = await nPend(orfao);
  await c.query(MIG074);
  assert.equal(await nPend(vivo), a); assert.equal(await nPend(orfao), b);
  assert.equal(a, 1); assert.equal(b, 0);
});

test('(6) multi-tenant: dedup particiona por tenant (cada tenant mantém 1)', async () => {
  await reset();
  const l1 = await lead(T1, 'QUALIFYING'); await seedPending(T1, l1, 3);
  const l2 = await lead(T2, 'QUALIFYING'); await seedPending(T2, l2, 3);
  await c.query(MIG074);
  assert.equal(await nPend(l1), 1, 'T1 mantém 1');
  assert.equal(await nPend(l2), 1, 'T2 mantém 1');
});
