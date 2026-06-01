'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const app = require('../src/server');
const { pool, withTenant } = require('../src/db');

// Tenant de teste (UUID v4) — criado no setup, removido no teardown.
const TENANT_ID = crypto.randomUUID();
const JWT_SECRET = process.env.JWT_SECRET;

const adminToken = jwt.sign({ sub: 'admin-1', role: 'PLATFORM_ADMIN' }, JWT_SECRET);
const userToken = jwt.sign({ sub: 'user-1', role: 'TENANT_USER' }, JWT_SECRET);

let baseUrl;
let server;

function patchConfig(body, token = adminToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${baseUrl}/admin/tenants/${TENANT_ID}/lead-config`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
}

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  // Cria o tenant alvo (com contexto RLS = próprio id).
  await withTenant(TENANT_ID, (c) =>
    c.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [TENANT_ID, 'Academia do Rock'])
  );
});

after(async () => {
  await withTenant(TENANT_ID, (c) => c.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]));
  await new Promise((r) => server.close(r));
  await pool.end();
});

test('cria config e resolve system_prompt pelo template padrão', async () => {
  const res = await patchConfig({
    school_name: 'Academia do Rock',
    available_instruments: ['Guitarra', 'Bateria', 'Baixo'],
    business_hours: { mon: '09:00-18:00', sat: '09:00-13:00' },
    notification_whatsapp: '+5511999998888',
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.created, true);
  assert.equal(data.config.system_prompt_override, null);
  // Template padrão renderizado com as variáveis.
  assert.match(data.config.system_prompt, /Academia do Rock/);
  assert.match(data.config.system_prompt, /Guitarra, Bateria, Baixo/);
  assert.match(data.config.system_prompt, /Seg: 09:00-18:00/);
});

test('atualiza config (PATCH parcial) preservando demais campos', async () => {
  const res = await patchConfig({ available_instruments: ['Piano', 'Violino'] });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.created, false);
  assert.deepEqual(data.config.available_instruments, ['Piano', 'Violino']);
  // school_name e whatsapp foram preservados do registro anterior.
  assert.equal(data.config.school_name, 'Academia do Rock');
  assert.equal(data.config.notification_whatsapp, '+5511999998888');
});

test('override no system_prompt tem prioridade sobre o template', async () => {
  const res = await patchConfig({ system_prompt_override: 'Prompt customizado XYZ' });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.config.system_prompt, 'Prompt customizado XYZ');
});

test('rejeita notification_whatsapp fora do formato E.164', async () => {
  const res = await patchConfig({ notification_whatsapp: '11999998888' });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /E\.164/);
});

test('rejeita business_hours com horário inválido', async () => {
  const res = await patchConfig({ business_hours: { mon: '9h-18h' } });
  assert.equal(res.status, 400);
});

test('exige autenticação (sem token -> 401)', async () => {
  const res = await patchConfig({ school_name: 'X' }, null);
  assert.equal(res.status, 401);
});

test('exige role PLATFORM_ADMIN (role errada -> 403)', async () => {
  const res = await patchConfig({ school_name: 'X' }, userToken);
  assert.equal(res.status, 403);
});
