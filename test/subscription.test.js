'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('../src/server'); // carrega módulos/env
const { pool, withTenant } = require('../src/db');
const svc = require('../src/subscriptionService');

const TENANT = crypto.randomUUID();
const LM = 'LEAD_MANAGER';
const q = (sql, params) => withTenant(TENANT, (c) => c.query(sql, params)).then((r) => r.rows);

before(async () => {
  await withTenant(TENANT, (c) => c.query("INSERT INTO tenants (id, name) VALUES ($1, 'Sub Test')", [TENANT]));
});

after(async () => {
  await withTenant(TENANT, (c) => c.query('DELETE FROM tenants WHERE id = $1', [TENANT]));
  await pool.end();
});

const eventsWithKey = (key) =>
  q('SELECT 1 FROM subscription_events WHERE idempotency_key = $1', [key]).then((r) => r.length);
const eventCount = (feature) =>
  q('SELECT 1 FROM subscription_events WHERE feature = $1', [feature]).then((r) => r.length);

test('startTrial -> TRIALING com valid_until no futuro', async () => {
  const { subscription } = await svc.startTrial({ tenantId: TENANT, feature: LM, days: 7, actor: 'leo' });
  assert.equal(subscription.status, 'TRIALING');
  assert.ok(subscription.trial_started_at);
  assert.ok(new Date(subscription.valid_until).getTime() > Date.now(), 'valid_until deve estar no futuro');

  const ev = await q("SELECT type, to_status FROM subscription_events WHERE feature = $1", [LM]);
  assert.ok(ev.some((e) => e.type === 'TRIAL_STARTED' && e.to_status === 'TRIALING'));
});

test('activate (MANUAL) -> ACTIVE + evento ACTIVATED + converted_at', async () => {
  const before = await eventCount(LM);
  const { subscription } = await svc.activate({
    tenantId: TENANT, feature: LM, source: 'MANUAL', actor: 'leo', idempotencyKey: 'k-act-1',
  });
  assert.equal(subscription.status, 'ACTIVE');
  assert.ok(subscription.converted_at, 'converted_at deve ser preenchido');
  assert.equal(await eventsWithKey('k-act-1'), 1);
  assert.equal(await eventCount(LM), before + 1, 'append-only: +1 evento');
});

test('idempotência: mesma idempotencyKey não duplica evento nem re-aplica', async () => {
  const before = await eventCount(LM);
  const { idempotent, subscription } = await svc.activate({
    tenantId: TENANT, feature: LM, source: 'MANUAL', actor: 'leo', idempotencyKey: 'k-act-1',
  });
  assert.equal(idempotent, true);
  assert.equal(subscription.status, 'ACTIVE');
  assert.equal(await eventsWithKey('k-act-1'), 1, 'continua 1 evento com a chave');
  assert.equal(await eventCount(LM), before, 'nenhum evento novo');
});

test('suspend -> SUSPENDED, depois reactivate -> ACTIVE', async () => {
  const s = await svc.suspend({ tenantId: TENANT, feature: LM, actor: 'leo' });
  assert.equal(s.subscription.status, 'SUSPENDED');
  const r = await svc.reactivate({ tenantId: TENANT, feature: LM, actor: 'leo' });
  assert.equal(r.subscription.status, 'ACTIVE');
});

test('cancel -> CANCELED com canceled_at', async () => {
  const { subscription } = await svc.cancel({ tenantId: TENANT, feature: LM, actor: 'leo' });
  assert.equal(subscription.status, 'CANCELED');
  assert.ok(subscription.canceled_at);
});

test('activate (STRIPE) grava stripe_subscription_id', async () => {
  const { subscription } = await svc.activate({
    tenantId: TENANT, feature: LM, source: 'STRIPE', externalRef: 'sub_123', actor: 'webhook', idempotencyKey: 'evt_stripe_1',
  });
  assert.equal(subscription.status, 'ACTIVE');
  assert.equal(subscription.stripe_subscription_id, 'sub_123');

  const ev = await q("SELECT source, external_ref FROM subscription_events WHERE idempotency_key = 'evt_stripe_1'", []);
  assert.equal(ev[0].source, 'STRIPE');
  assert.equal(ev[0].external_ref, 'sub_123');
});

test('expire -> EXPIRED (source SYSTEM) em outra feature', async () => {
  await svc.startTrial({ tenantId: TENANT, feature: 'SCHEDULER', days: 1, actor: 'leo' });
  const { subscription } = await svc.expire({ tenantId: TENANT, feature: 'SCHEDULER' });
  assert.equal(subscription.status, 'EXPIRED');
  const ev = await q("SELECT source, type FROM subscription_events WHERE feature='SCHEDULER' AND type='EXPIRED'", []);
  assert.equal(ev[0].source, 'SYSTEM');
});

test('suspend em feature inexistente falha (allowCreate=false)', async () => {
  await assert.rejects(
    () => svc.suspend({ tenantId: TENANT, feature: 'SCHEDULER_INEXISTENTE', actor: 'leo' }),
    /assinatura inexistente|violates check constraint/
  );
});
