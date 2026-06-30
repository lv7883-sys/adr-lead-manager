'use strict';
//
// ADR-029 fatia 3 — TESTE DE ISOLAMENTO MULTI-TENANT (§7, critério de aceite).
// Prova que o gate seta app.current_tenant antes de ler contact_role_member e que a RLS
// impede um tenant de enxergar papel/pré-marca/sombra de outro. Não liga sem isto verde.
//
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool, withTenant } = require('../src/db');
const {
  _lookupRole, _presignalActive, _evaluateGateSuppression, _shadowLog,
} = require('../src/engine');

const A = crypto.randomUUID();   // tenant A — tem o papel/histórico
const B = crypto.randomUUID();   // tenant B — NUNCA pode enxergar nada de A
const PHONE_HARD = '5519988887777';   // contato com papel hard em A
const PHONE_HIST = '5519988886666';   // contato com confirmed_not_lead em A (presignal por histórico)

let roleId;

before(async () => {
  for (const id of [A, B]) {
    await withTenant(id, (c) => c.query(
      `INSERT INTO tenants (id, name, lead_manager_active, zapi_token)
       VALUES ($1, $2, true, $3)`,
      [id, 'GateIso ' + id.slice(0, 8), 'tok-' + id.slice(0, 8)]));
  }
  // A: papel hard + membro
  roleId = (await withTenant(A, (c) => c.query(
    `INSERT INTO contact_role (tenant_id, key, label, axis, suppression)
     VALUES ($1, 'staff_test', 'Staff Test', 'internal', 'hard') RETURNING id`, [A]))).rows[0].id;
  await withTenant(A, (c) => c.query(
    `INSERT INTO contact_role_member (tenant_id, phone, role_id) VALUES ($1, $2, $3)`,
    [A, PHONE_HARD, roleId]));
  // A: lead confirmed_not_lead recente (fonte da pré-sinalização por histórico)
  await withTenant(A, (c) => c.query(
    `INSERT INTO leads (tenant_id, name, phone, status, review_result, review_em)
     VALUES ($1, 'Hist A', $2, 'NOT_LEAD', 'confirmed_not_lead', now())`, [A, PHONE_HIST]));
  // A: uma linha de sombra
  await _shadowLog(A, { phone: PHONE_HARD, channel: 'whatsapp', wouldAction: 'hard', roleId, reason: 'role:staff_test', externalMessageId: 'iso-1' });
});

after(async () => {
  for (const id of [A, B]) {
    await withTenant(id, (c) => c.query('DELETE FROM tenants WHERE id = $1', [id])); // CASCADE limpa role/member/leads/shadow
  }
  await pool.end();
});

test('papel hard é visível DENTRO do tenant dono (A)', async () => {
  const role = await _lookupRole(A, PHONE_HARD);
  assert.ok(role, 'A deve enxergar o próprio papel');
  assert.equal(role.suppression, 'hard');
});

test('RLS: tenant B NÃO enxerga o papel de A (mesmo telefone)', async () => {
  const role = await _lookupRole(B, PHONE_HARD);
  assert.equal(role, null, 'B nunca pode ver contact_role_member de A');
});

test('evaluate: A=hard; B=sem supressão nenhuma', async () => {
  const a = await _evaluateGateSuppression(A, PHONE_HARD, { ttlDays: 30 });
  assert.deepEqual({ hard: a.hard, presignal: a.presignal }, { hard: true, presignal: false });
  const b = await _evaluateGateSuppression(B, PHONE_HARD, { ttlDays: 30 });
  assert.deepEqual({ hard: b.hard, presignal: b.presignal }, { hard: false, presignal: false });
});

test('presignal por histórico isola por tenant', async () => {
  assert.equal(await _presignalActive(A, PHONE_HIST, 30), true, 'A vê o próprio confirmed_not_lead');
  assert.equal(await _presignalActive(B, PHONE_HIST, 30), false, 'B nunca vê o histórico de A');
});

test('gate_shadow_log isola por tenant', async () => {
  const inA = (await withTenant(A, (c) => c.query('SELECT count(*)::int n FROM gate_shadow_log'))).rows[0].n;
  const inB = (await withTenant(B, (c) => c.query('SELECT count(*)::int n FROM gate_shadow_log'))).rows[0].n;
  assert.ok(inA >= 1, 'A deve ver a própria linha de sombra');
  assert.equal(inB, 0, 'B nunca vê sombra de A');
});
