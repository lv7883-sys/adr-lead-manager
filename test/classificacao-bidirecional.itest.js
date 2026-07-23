'use strict';
// classificacao-bidirecional.itest.js — Fatia F: botão lead↔não-lead + Undo (snapshot-restore).
// Mirror FIEL da sequência SQL do handler /requalificar e /restore-classificacao. PG descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

let c;
const T1 = '00000000-0000-0000-0000-0000000000f1';
const T2 = '00000000-0000-0000-0000-0000000000f2';

async function lead(tenant, over = {}) {
  const o = { status: 'QUALIFIED', review_result: null, temperatura_manual: 'morno', ...over };
  const reviewEm = o.review_result ? new Date(Date.now() - 10 * 86400000).toISOString() : null;
  const reviewBy = o.review_result ? 'SERVICE' : null;
  return (await c.query(
    `INSERT INTO leads (tenant_id, status, review_result, review_em, review_by, temperatura_manual)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [tenant, o.status, o.review_result, reviewEm, reviewBy, o.temperatura_manual])).rows[0].id;
}
const pend = (tenant, leadId) => c.query(
  `INSERT INTO pending_approvals (tenant_id, lead_id, status) VALUES ($1,$2,'PENDING') RETURNING id`, [tenant, leadId]).then(r => r.rows[0].id);
const nfb = async (leadId) => (await c.query(`SELECT count(*)::int n FROM classification_feedback WHERE lead_id=$1`, [leadId])).rows[0].n;
const npend = async (leadId) => (await c.query(`SELECT count(*)::int n FROM pending_approvals WHERE lead_id=$1 AND status='PENDING'`, [leadId])).rows[0].n;
const leadRow = async (leadId) => (await c.query(`SELECT status, review_result, temperatura_manual FROM leads WHERE id=$1`, [leadId])).rows[0];

// ---- mirror do handler ----------------------------------------------------
async function snapshotPrior(tenant, id) {
  return (await c.query('SELECT status, review_result, review_em, review_by, temperatura_manual FROM leads WHERE id=$1', [id])).rows[0];
}
async function feedback(tenant, id, label) {
  return (await c.query(`INSERT INTO classification_feedback (tenant_id, lead_id, correct_label) VALUES ($1,$2,$3) RETURNING id`, [tenant, id, label])).rows[0].id;
}
async function rebaixar(tenant, id) {   // classification='not_lead'
  const prior = await snapshotPrior(tenant, id);
  await c.query("UPDATE leads SET status='NOT_LEAD', review_result='confirmed_not_lead', review_em=now(), review_by='SERVICE' WHERE id=$1", [id]);
  const fb = await feedback(tenant, id, 'not_lead');
  const arch = await c.query("UPDATE pending_approvals SET status='ARCHIVED' WHERE tenant_id=$1 AND lead_id=$2 AND status='PENDING' RETURNING id", [tenant, id]);
  return { lead_id: id, prior, feedback_id: fb, draft_created_id: null, drafts_archived: arch.rows.map(r => r.id) };
}
async function promover(tenant, id, { dup = false } = {}) {  // classification='lead'
  const prior = await snapshotPrior(tenant, id);
  await c.query("UPDATE leads SET status='QUALIFYING', review_result='confirmed_lead', review_em=now(), review_by='SERVICE' WHERE id=$1", [id]);
  const fb = await feedback(tenant, id, 'lead');
  // generateDraftForLead: cria PENDING se não houver (dup=false) — simula o retorno
  let draftCreated = null;
  if (!dup) draftCreated = await pend(tenant, id);
  return { lead_id: id, prior, feedback_id: fb, draft_created_id: draftCreated, drafts_archived: [] };
}
async function restore(tenant, id, snap) {   // UNDO
  const p = snap.prior;
  await c.query(`UPDATE leads SET status=$2, review_result=$3, review_em=$4, review_by=$5, temperatura_manual=$6 WHERE id=$1`,
    [id, p.status, p.review_result, p.review_em, p.review_by, p.temperatura_manual]);
  if (snap.feedback_id) await c.query('DELETE FROM classification_feedback WHERE id=$1 AND lead_id=$2', [snap.feedback_id, id]);
  if (snap.drafts_archived?.length) await c.query("UPDATE pending_approvals SET status='PENDING' WHERE lead_id=$1 AND id=ANY($2::uuid[])", [id, snap.drafts_archived]);
  if (snap.draft_created_id) await c.query("UPDATE pending_approvals SET status='ARCHIVED' WHERE id=$1 AND lead_id=$2", [snap.draft_created_id, id]);
}

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  await c.query(`
    CREATE TABLE leads (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, status text, review_result text,
      review_em timestamptz, review_by text, temperatura_manual text);
    CREATE TABLE pending_approvals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, lead_id uuid, status text DEFAULT 'PENDING');
    CREATE TABLE classification_feedback (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, lead_id uuid, correct_label text);`);
});
after(async () => { await c.end(); });

test('(1) rebaixar → NOT_LEAD + latch confirmed_not_lead + PENDING arquivado + feedback', async () => {
  const id = await lead(T1, { status: 'QUALIFIED' });
  await pend(T1, id); await pend(T1, id);   // 2 PENDING (será que arquiva ambos)
  const snap = await rebaixar(T1, id);
  const r = await leadRow(id);
  assert.equal(r.status, 'NOT_LEAD'); assert.equal(r.review_result, 'confirmed_not_lead');
  assert.equal(await npend(id), 0, 'PENDING arquivados (guardrail Fatia D)');
  assert.equal(await nfb(id), 1, 'feedback registrado');
  assert.equal(snap.drafts_archived.length, 2, 'snapshot guarda os 2 arquivados');
  assert.equal(snap.prior.status, 'QUALIFIED', 'snapshot capturou o status EXATO anterior');
});

test('(2) promover → QUALIFYING + latch confirmed_lead + draft criado + feedback', async () => {
  const id = await lead(T1, { status: 'NOT_LEAD', review_result: 'confirmed_not_lead' });
  const snap = await promover(T1, id);
  const r = await leadRow(id);
  assert.equal(r.status, 'QUALIFYING'); assert.equal(r.review_result, 'confirmed_lead');
  assert.equal(await npend(id), 1, 'draft gerado');
  assert.equal(await nfb(id), 1, 'feedback lead');
  assert.ok(snap.draft_created_id, 'snapshot guarda o draft NOVO');
});

test('(3) UNDO do rebaixe restaura status EXATO (QUALIFIED, não QUALIFYING) + desarquiva + apaga feedback', async () => {
  const id = await lead(T1, { status: 'QUALIFIED', temperatura_manual: 'quente' });
  const d1 = await pend(T1, id);
  const snap = await rebaixar(T1, id);
  assert.equal((await leadRow(id)).status, 'NOT_LEAD');
  await restore(T1, id, snap);
  const r = await leadRow(id);
  assert.equal(r.status, 'QUALIFIED', 'restaurou o status EXATO (não o genérico QUALIFYING)');
  assert.equal(r.review_result, null, 'review_result anterior (era NULL) restaurado');
  assert.equal(r.temperatura_manual, 'quente', 'temperatura anterior restaurada');
  assert.equal(await npend(id), 1, 'PENDING desarquivado (voltou)');
  assert.equal(await nfb(id), 0, 'feedback APAGADO (não ensina flip-flop)');
});

test('(4) UNDO da promoção arquiva o draft NOVO + apaga feedback + restaura NOT_LEAD/confirmed_not_lead', async () => {
  const id = await lead(T1, { status: 'NOT_LEAD', review_result: 'confirmed_not_lead' });
  const snap = await promover(T1, id);
  assert.equal(await npend(id), 1);
  await restore(T1, id, snap);
  const r = await leadRow(id);
  assert.equal(r.status, 'NOT_LEAD'); assert.equal(r.review_result, 'confirmed_not_lead');
  assert.equal(await npend(id), 0, 'draft NOVO arquivado no undo');
  assert.equal(await nfb(id), 0, 'feedback apagado');
});

test('(5) UNDO de promoção com draft DUP não arquiva o pré-existente', async () => {
  const id = await lead(T1, { status: 'NOT_LEAD' });
  const preexistente = await pend(T1, id);   // já tinha um PENDING
  const snap = await promover(T1, id, { dup: true });   // dup → draft_created_id null
  assert.equal(snap.draft_created_id, null);
  await restore(T1, id, snap);
  assert.equal(await npend(id), 1, 'o PENDING pré-existente NÃO foi arquivado (não era da ação)');
});

test('(6) multi-tenant: restore só toca o lead do tenant (feedback/draft por lead)', async () => {
  const a = await lead(T1); const b = await lead(T2);
  await pend(T1, a); await pend(T2, b);
  const snapA = await rebaixar(T1, a);
  await restore(T1, a, snapA);
  assert.equal(await npend(b), 1, 'lead do T2 intacto');
  assert.equal(await nfb(b), 0, 'sem feedback vazado p/ T2');
  assert.equal((await leadRow(a)).status, 'QUALIFIED', 'T1 restaurado');
});
