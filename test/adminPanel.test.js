'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const app = require('../src/server');
const { pool, withTenant } = require('../src/db');
const redisClient = require('../src/redisClient');

const JWT_SECRET = process.env.JWT_SECRET;
const PLATFORM_USER = crypto.randomUUID();
const REGULAR_USER = crypto.randomUUID();
const adminToken = jwt.sign({ sub: PLATFORM_USER }, JWT_SECRET);
const userToken = jwt.sign({ sub: REGULAR_USER }, JWT_SECRET);

let server;
let baseUrl;
let createdTenantId;

function api(path, { method = 'GET', body, token = adminToken } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await pool.query(
    `INSERT INTO users (id, email, is_platform_admin) VALUES ($1,'padmin-panel@t', true), ($2,'reg-panel@t', false)`,
    [PLATFORM_USER, REGULAR_USER]
  );
});

after(async () => {
  if (createdTenantId) {
    await withTenant(createdTenantId, (c) => c.query('DELETE FROM tenants WHERE id = $1', [createdTenantId]));
  }
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [[PLATFORM_USER, REGULAR_USER]]);
  await redisClient.redis.quit().catch(() => {});
  await new Promise((r) => server.close(r));
  await pool.end();
});

test('POST /admin/tenants cria tenant + trial (duração customizada)', async () => {
  const res = await api('/admin/tenants', { method: 'POST', body: { name: 'Nova Escola', trial_days: 5 } });
  assert.equal(res.status, 201);
  const data = await res.json();
  createdTenantId = data.tenant_id;
  assert.ok(createdTenantId);
  assert.equal(data.subscription.status, 'TRIALING');
  assert.ok(new Date(data.subscription.valid_until).getTime() > Date.now());
});

test('GET /admin/tenants lista o tenant com status e dias restantes', async () => {
  const res = await api('/admin/tenants');
  assert.equal(res.status, 200);
  const { tenants } = await res.json();
  const t = tenants.find((x) => x.tenant_id === createdTenantId);
  assert.ok(t, 'tenant criado aparece na lista');
  const lm = t.features.find((f) => f.feature === 'LEAD_MANAGER');
  assert.equal(lm.status, 'TRIALING');
  assert.ok(lm.days_remaining >= 4 && lm.days_remaining <= 5);
});

test('POST .../activate converte trial -> ACTIVE', async () => {
  const res = await api(`/admin/tenants/${createdTenantId}/subscriptions/LEAD_MANAGER/activate`, { method: 'POST', body: {} });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.subscription.status, 'ACTIVE');
  assert.ok(data.subscription.converted_at);
});

test('POST .../suspend e .../reactivate', async () => {
  const s = await api(`/admin/tenants/${createdTenantId}/subscriptions/LEAD_MANAGER/suspend`, { method: 'POST', body: {} });
  assert.equal((await s.json()).subscription.status, 'SUSPENDED');
  const r = await api(`/admin/tenants/${createdTenantId}/subscriptions/LEAD_MANAGER/reactivate`, { method: 'POST', body: {} });
  assert.equal((await r.json()).subscription.status, 'ACTIVE');
});

test('PATCH /admin/settings altera default_trial_days', async () => {
  const res = await api('/admin/settings', { method: 'PATCH', body: { default_trial_days: 14 } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).settings.default_trial_days, 14);
  // Restaura o default global para não afetar outros testes.
  await api('/admin/settings', { method: 'PATCH', body: { default_trial_days: 7 } });
});

test('GET /admin/metrics retorna agregados comerciais', async () => {
  const res = await api('/admin/metrics');
  assert.equal(res.status, 200);
  const m = await res.json();
  for (const k of ['active_trials', 'active_paid', 'conversions', 'expirations', 'estimated_mrr']) {
    assert.equal(typeof m[k], 'number', `${k} numérico`);
  }
  assert.ok(m.active_paid >= 1, 'nosso tenant ACTIVE conta no active_paid');
  assert.ok(m.conversion_rate === null || (m.conversion_rate >= 0 && m.conversion_rate <= 1));
});

test('autorização: sem token -> 401; usuário não-admin -> 403', async () => {
  assert.equal((await api('/admin/tenants', { token: null })).status, 401);
  assert.equal((await api('/admin/tenants', { token: userToken })).status, 403);
});

test('POST /admin/tenants sem name -> 400', async () => {
  const res = await api('/admin/tenants', { method: 'POST', body: { trial_days: 5 } });
  assert.equal(res.status, 400);
});
