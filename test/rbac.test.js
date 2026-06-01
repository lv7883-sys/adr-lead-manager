'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const app = require('../src/server');
const { pool, withTenant } = require('../src/db');

const JWT_SECRET = process.env.JWT_SECRET;

// Dois tenants e cinco usuários cobrindo os papéis.
const TENANT_A = crypto.randomUUID();
const TENANT_B = crypto.randomUUID();
const U = {
  platformAdmin: crypto.randomUUID(),
  adminA: crypto.randomUUID(),
  recepA: crypto.randomUUID(),
  visualizadorA: crypto.randomUUID(),
  outsider: crypto.randomUUID(),
};
const tokenFor = (id) => jwt.sign({ sub: id }, JWT_SECRET);

let server;
let baseUrl;

function get(path, userId) {
  const headers = {};
  if (userId) headers.Authorization = `Bearer ${tokenFor(userId)}`;
  return fetch(`${baseUrl}${path}`, { headers });
}

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Usuários (tabela sem RLS) — um deles é PLATFORM_ADMIN.
  await pool.query(
    `INSERT INTO users (id, email, is_platform_admin) VALUES
      ($1,'padmin@t.test', true),
      ($2,'admina@t.test', false),
      ($3,'recepa@t.test', false),
      ($4,'visua@t.test',  false),
      ($5,'out@t.test',    false)`,
    [U.platformAdmin, U.adminA, U.recepA, U.visualizadorA, U.outsider]
  );

  // Tenants + memberships (RLS: inserir sob o contexto de cada tenant).
  await withTenant(TENANT_A, async (c) => {
    await c.query("INSERT INTO tenants (id, name) VALUES ($1, 'Tenant A')", [TENANT_A]);
    await c.query(
      `INSERT INTO tenant_members (user_id, tenant_id, role) VALUES
        ($1,$4,'TENANT_ADMIN'), ($2,$4,'RECEPCAO'), ($3,$4,'VISUALIZADOR')`,
      [U.adminA, U.recepA, U.visualizadorA, TENANT_A]
    );
    await c.query("INSERT INTO leads (tenant_id, name, phone, status) VALUES ($1,'Lead 1','+5511900000000','NEW')", [TENANT_A]);
  });
  await withTenant(TENANT_B, (c) => c.query("INSERT INTO tenants (id, name) VALUES ($1, 'Tenant B')", [TENANT_B]));
});

after(async () => {
  await withTenant(TENANT_A, (c) => c.query('DELETE FROM tenants WHERE id = $1', [TENANT_A]));
  await withTenant(TENANT_B, (c) => c.query('DELETE FROM tenants WHERE id = $1', [TENANT_B]));
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [Object.values(U)]);
  await new Promise((r) => server.close(r));
  await pool.end();
});

// ---------------- acesso correto por role ----------------

test('TENANT_ADMIN acessa /members do seu tenant (200)', async () => {
  const res = await get(`/tenant/${TENANT_A}/members`, U.adminA);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.role, 'TENANT_ADMIN');
  assert.equal(data.members.length, 3);
});

test('RECEPCAO acessa /leads (role suficiente para leitura) (200)', async () => {
  const res = await get(`/tenant/${TENANT_A}/leads`, U.recepA);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.role, 'RECEPCAO');
  assert.equal(data.leads.length, 1);
});

test('VISUALIZADOR acessa /leads (200)', async () => {
  const res = await get(`/tenant/${TENANT_A}/leads`, U.visualizadorA);
  assert.equal(res.status, 200);
});

// ---------------- rejeição de role insuficiente ----------------

test('RECEPCAO é barrada em /members (403)', async () => {
  const res = await get(`/tenant/${TENANT_A}/members`, U.recepA);
  assert.equal(res.status, 403);
});

test('VISUALIZADOR é barrado em /members (403)', async () => {
  const res = await get(`/tenant/${TENANT_A}/members`, U.visualizadorA);
  assert.equal(res.status, 403);
});

test('usuário sem membership no tenant é barrado (403)', async () => {
  const res = await get(`/tenant/${TENANT_A}/leads`, U.outsider);
  assert.equal(res.status, 403);
});

test('papel num tenant não vale em outro tenant (403)', async () => {
  // adminA é TENANT_ADMIN de A, mas não tem papel em B.
  const res = await get(`/tenant/${TENANT_B}/members`, U.adminA);
  assert.equal(res.status, 403);
});

// ---------------- PLATFORM_ADMIN acessa qualquer tenant ----------------

test('PLATFORM_ADMIN acessa qualquer tenant via impersonation auditada (200 + auditoria)', async () => {
  const resA = await get(`/tenant/${TENANT_A}/members`, U.platformAdmin);
  assert.equal(resA.status, 200);
  const dataA = await resA.json();
  assert.equal(dataA.role, 'PLATFORM_ADMIN');

  // Acessa também o tenant B, onde não tem membership.
  const resB = await get(`/tenant/${TENANT_B}/members`, U.platformAdmin);
  assert.equal(resB.status, 200);

  // Cada acesso gerou registro de auditoria de impersonation.
  const audit = await pool.query(
    'SELECT tenant_id FROM impersonation_audit WHERE platform_user_id = $1',
    [U.platformAdmin]
  );
  assert.ok(audit.rowCount >= 2, 'deve haver auditoria para os acessos do PLATFORM_ADMIN');
  const tenants = audit.rows.map((r) => r.tenant_id);
  assert.ok(tenants.includes(TENANT_A) && tenants.includes(TENANT_B));
});

// ---------------- autenticação ----------------

test('sem token -> 401', async () => {
  const res = await get(`/tenant/${TENANT_A}/leads`, null);
  assert.equal(res.status, 401);
});
