'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const app = require('../src/server');
const { pool, withTenant } = require('../src/db');

const JWT_SECRET = process.env.JWT_SECRET;
const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();
const U = {
  platformAdmin: crypto.randomUUID(),
  adminA: crypto.randomUUID(),
  recepA: crypto.randomUUID(),
  adminB: crypto.randomUUID(),
};
const tok = (id) => jwt.sign({ sub: id }, JWT_SECRET);

let server;
let baseUrl;

function patch(tenant, body, userId) {
  const headers = { 'Content-Type': 'application/json' };
  if (userId) headers.Authorization = `Bearer ${tok(userId)}`;
  return fetch(`${baseUrl}/tenant/${tenant}/lead-config`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
}

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(
    `INSERT INTO users (id, email, is_platform_admin) VALUES
      ($1,'padmin-tc@t', true), ($2,'adminA-tc@t', false),
      ($3,'recepA-tc@t', false), ($4,'adminB-tc@t', false)`,
    [U.platformAdmin, U.adminA, U.recepA, U.adminB]
  );
  await withTenant(TENANT_A, async (c) => {
    await c.query("INSERT INTO tenants (id, name) VALUES ($1, 'Tenant A')", [TENANT_A]);
    await c.query(
      `INSERT INTO tenant_members (user_id, tenant_id, role) VALUES ($1,$3,'TENANT_ADMIN'), ($2,$3,'RECEPCAO')`,
      [U.adminA, U.recepA, TENANT_A]
    );
  });
  await withTenant(TENANT_B, async (c) => {
    await c.query("INSERT INTO tenants (id, name) VALUES ($1, 'Tenant B')", [TENANT_B]);
    await c.query(
      `INSERT INTO tenant_members (user_id, tenant_id, role) VALUES ($1,$2,'TENANT_ADMIN')`,
      [U.adminB, TENANT_B]
    );
  });
});

after(async () => {
  await withTenant(TENANT_A, (c) => c.query('DELETE FROM tenants WHERE id = $1', [TENANT_A]));
  await withTenant(TENANT_B, (c) => c.query('DELETE FROM tenants WHERE id = $1', [TENANT_B]));
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [Object.values(U)]);
  await new Promise((r) => server.close(r));
  await pool.end();
});

test('TENANT_ADMIN configura o lead-config do próprio tenant (200)', async () => {
  const res = await patch(TENANT_A, { school_name: 'Academia A' }, U.adminA);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.config.school_name, 'Academia A');
});

test('RECEPCAO é barrada no lead-config (403)', async () => {
  const res = await patch(TENANT_A, { school_name: 'Hack' }, U.recepA);
  assert.equal(res.status, 403);
});

test('TENANT_ADMIN de outro tenant é barrado (403)', async () => {
  const res = await patch(TENANT_A, { school_name: 'Cross' }, U.adminB);
  assert.equal(res.status, 403);
});

test('PLATFORM_ADMIN configura via impersonation (200)', async () => {
  const res = await patch(TENANT_A, { available_instruments: ['Piano'] }, U.platformAdmin);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).config.available_instruments, ['Piano']);
});

test('sem token -> 401', async () => {
  const res = await patch(TENANT_A, { school_name: 'X' }, null);
  assert.equal(res.status, 401);
});

test('validação roda após autorização: E.164 inválido -> 400', async () => {
  const res = await patch(TENANT_A, { notification_whatsapp: '11999998888' }, U.adminA);
  assert.equal(res.status, 400);
});
