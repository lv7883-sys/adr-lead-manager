'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('../src/server');
const { pool, withTenant } = require('../src/db');
const redisClient = require('../src/redisClient');
const { runTrialExpiry } = require('../src/jobs/trialExpiry');

const DAY = 86400000;
const LM = 'LEAD_MANAGER';
const testTenantIds = [];

// loadDue escopado aos tenants deste teste (usa a função SECURITY DEFINER real,
// mas só sobre os nossos tenants -> isolamento de testes em paralelo).
const loadDue = async () => {
  const { rows } = await pool.query(
    'SELECT * FROM trial_lifecycle_due() WHERE tenant_id = ANY($1)',
    [testTenantIds]
  );
  return rows;
};

const sent = [];
const sendReminder = async (r) => {
  sent.push(r);
};

async function makeSub({ status, validUntil, graceUntil }) {
  const tid = crypto.randomUUID();
  testTenantIds.push(tid);
  const subId = await withTenant(tid, async (c) => {
    await c.query("INSERT INTO tenants (id, name) VALUES ($1, 'cron')", [tid]);
    const r = await c.query(
      `INSERT INTO tenant_subscriptions (tenant_id, feature, status, valid_until, grace_until)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tid, LM, status, validUntil, graceUntil]
    );
    return r.rows[0].id;
  });
  return { tid, subId };
}

const statusOf = (tid) =>
  withTenant(tid, (c) => c.query('SELECT status, grace_until FROM tenant_subscriptions WHERE tenant_id = $1', [tid]))
    .then((r) => r.rows[0]);

let expiredTrial, graceExpired, d3, d1, active;

before(async () => {
  expiredTrial = await makeSub({ status: 'TRIALING', validUntil: new Date(Date.now() - DAY), graceUntil: null });
  graceExpired = await makeSub({ status: 'GRACE', validUntil: new Date(Date.now() - 5 * DAY), graceUntil: new Date(Date.now() - DAY) });
  d3 = await makeSub({ status: 'TRIALING', validUntil: new Date(Date.now() + 2.5 * DAY), graceUntil: null });
  d1 = await makeSub({ status: 'TRIALING', validUntil: new Date(Date.now() + 0.5 * DAY), graceUntil: null });
  active = await makeSub({ status: 'ACTIVE', validUntil: new Date(Date.now() + 30 * DAY), graceUntil: null });
});

after(async () => {
  for (const tid of testTenantIds) {
    await withTenant(tid, (c) => c.query('DELETE FROM tenants WHERE id = $1', [tid]));
  }
  await redisClient.redis.quit().catch(() => {});
  await pool.end();
});

test('TRIALING vencido -> GRACE; GRACE vencido -> SUSPENDED; D-3/D-1 lembrete; ACTIVE intacta', async () => {
  const summary = await runTrialExpiry({ now: new Date(), loadDue, sendReminder });

  // Transições de estado.
  assert.equal((await statusOf(expiredTrial.tid)).status, 'GRACE');
  assert.ok((await statusOf(expiredTrial.tid)).grace_until, 'grace_until preenchido');
  assert.equal((await statusOf(graceExpired.tid)).status, 'SUSPENDED');
  assert.equal((await statusOf(active.tid)).status, 'ACTIVE', 'ACTIVE não é afetada');

  assert.equal(summary.graced, 1);
  assert.equal(summary.suspended, 1);

  // Lembretes gerados: EXPIRED (trial vencido), D-3, D-1.
  const marcos = sent.map((s) => `${s.marco}:${s.tenantId}`);
  assert.ok(marcos.includes(`EXPIRED:${expiredTrial.tid}`));
  assert.ok(marcos.includes(`D-3:${d3.tid}`));
  assert.ok(marcos.includes(`D-1:${d1.tid}`));
  assert.equal(sent.length, 3, 'exatamente 3 lembretes na 1ª execução');
});

test('segunda execução não duplica lembretes (idempotência por marco)', async () => {
  const lenBefore = sent.length;
  await runTrialExpiry({ now: new Date(), loadDue, sendReminder });
  assert.equal(sent.length, lenBefore, 'nenhum lembrete duplicado');

  // reminder_sent tem exatamente os 3 marcos travados.
  const rows = await pool.query(
    'SELECT marco FROM reminder_sent WHERE subscription_id = ANY($1)',
    [[expiredTrial.subId, d3.subId, d1.subId]]
  );
  assert.equal(rows.rowCount, 3);
});
