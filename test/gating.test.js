'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

require('../src/server');
const { pool, withTenant } = require('../src/db');
const redisClient = require('../src/redisClient');
const engine = require('../src/engine');
const gating = require('../src/gating');
const svc = require('../src/subscriptionService');

const TENANT = crypto.randomUUID();
const LM = 'LEAD_MANAGER';
const q = (sql, params) => withTenant(TENANT, (c) => c.query(sql, params)).then((r) => r.rows);

const tenant = { id: TENANT };

// Deps que processam o funil completo (Portão 1/2) — usadas quando LIBERADO.
const allowedDeps = () => ({
  classify: async () => ({ label: 'LEAD', confidence: 0.95, reason: 'ok' }),
  generate: async () => 'Resposta sugerida.',
  classifyIntent: async () => 'GENERAL_INFO',
  extract: async () => ({ name: null, instrument: null, availability: null, ambiguous: [] }),
  notify: async () => ({ sent: true }),
  redis: redisClient,
});

// Deps que FALHAM se chamadas — provam que o gating barrou antes do Gemini.
const blockedDeps = () => ({
  classify: async () => assert.fail('classify não deveria ser chamado (gating)'),
  generate: async () => assert.fail('generate não deveria ser chamado (gating)'),
  classifyIntent: async () => assert.fail('classifyIntent não deveria ser chamado'),
  extract: async () => assert.fail('extract não deveria ser chamado'),
  notify: async () => ({ sent: false }),
  redis: redisClient,
});

const inbound = (digits, body = 'quero aula') => ({
  externalId: digits,
  externalMessageId: `g-${digits}`,
  sender: 'Lead',
  body,
});
const leadExists = (phone) =>
  q('SELECT 1 FROM leads WHERE tenant_id = $1 AND phone = $2', [TENANT, phone]).then((r) => r.length > 0);

async function setSubRaw(status, validUntilSql) {
  await q(
    `INSERT INTO tenant_subscriptions (tenant_id, feature, status, valid_until)
       VALUES ($1, $2, $3, ${validUntilSql})
     ON CONFLICT (tenant_id, feature) DO UPDATE SET status = EXCLUDED.status, valid_until = EXCLUDED.valid_until`,
    [TENANT, LM, status]
  );
  await redisClient.invalidateSubStatus(TENANT, 'lead_manager');
}

before(async () => {
  await withTenant(TENANT, async (c) => {
    await c.query("INSERT INTO tenants (id, name) VALUES ($1, 'Gating Test')", [TENANT]);
    await c.query(
      "INSERT INTO tenant_lead_config (tenant_id, school_name, business_hours) VALUES ($1, 'Escola', '{}'::jsonb)",
      [TENANT]
    );
  });
});

after(async () => {
  await withTenant(TENANT, (c) => c.query('DELETE FROM tenants WHERE id = $1', [TENANT]));
  await redisClient.redis.quit().catch(() => {});
  await pool.end();
});

test('ACTIVE -> processa normalmente', async () => {
  await svc.activate({ tenantId: TENANT, feature: LM, source: 'MANUAL', actor: 'leo', idempotencyKey: 'gat-active' });
  await engine.processInbound(tenant, inbound('5511970000001'), {}, allowedDeps());
  assert.equal(await leadExists('+5511970000001'), true);
});

test('TRIALING válido -> processa normalmente', async () => {
  await svc.startTrial({ tenantId: TENANT, feature: LM, days: 7, actor: 'leo' });
  await engine.processInbound(tenant, inbound('5511970000002'), {}, allowedDeps());
  assert.equal(await leadExists('+5511970000002'), true);
});

test('TRIALING expirado (valid_until < now) -> bloqueado', async () => {
  await setSubRaw('TRIALING', "now() - interval '1 day'");
  await engine.processInbound(tenant, inbound('5511970000003'), {}, blockedDeps());
  assert.equal(await leadExists('+5511970000003'), false);
});

test('GRACE -> bloqueado (automação gated)', async () => {
  await setSubRaw('GRACE', "now() + interval '2 days'");
  await engine.processInbound(tenant, inbound('5511970000004'), {}, blockedDeps());
  assert.equal(await leadExists('+5511970000004'), false);
});

test('SUSPENDED -> bloqueado', async () => {
  await svc.suspend({ tenantId: TENANT, feature: LM, actor: 'leo' });
  await engine.processInbound(tenant, inbound('5511970000005'), {}, blockedDeps());
  assert.equal(await leadExists('+5511970000005'), false);
});

test('sem assinatura -> bloqueado', async () => {
  await q('DELETE FROM tenant_subscriptions WHERE tenant_id = $1', [TENANT]);
  await redisClient.invalidateSubStatus(TENANT, 'lead_manager');
  await engine.processInbound(tenant, inbound('5511970000006'), {}, blockedDeps());
  assert.equal(await leadExists('+5511970000006'), false);
});

test('cache hit -> segunda leitura não bate no banco (source cache)', async () => {
  await svc.activate({ tenantId: TENANT, feature: LM, source: 'MANUAL', actor: 'leo', idempotencyKey: 'gat-cache' });
  const first = await gating.resolveStatus(TENANT, { redis: redisClient });
  assert.equal(first.source, 'db'); // após invalidação do activate
  assert.equal(first.verdict, 'active');
  const second = await gating.resolveStatus(TENANT, { redis: redisClient });
  assert.equal(second.source, 'cache');
  assert.equal(second.verdict, 'active');
});
