'use strict';

// Testes de INTEGRAÇÃO do endpoint GET /tenant/:tid/resources/:rid/ocupacao-recorrente (aditivo).
// Lê a ocupação física vigente do occupation_history (mesma base da /disponibilidade) para UM
// recurso e devolve os intervalos ocupados por weekday. Prova: merge de slots adjacentes, slot
// livre não pinta, e ISOLAMENTO por tenant (recurso de A é invisível a B → 404). PG descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool, withTenant } = require('../src/db');

const TENANT_A = process.env.RESOURCES_TENANT_A;
const TENANT_B = process.env.RESOURCES_TENANT_B;
const TOKEN = jwt.sign({ role: 'service', service: 'itest' }, process.env.JWT_SECRET);

let server; let base;
let ridA; let ridB;

function getJSON(path) {
  return new Promise((resolve, reject) => {
    http.get(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
      let body = ''; res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(body || '{}') }));
    }).on('error', reject);
  });
}

// semeia 1 capability + 1 professor + linhas de occupation_history num tenant; devolve o resource id.
async function seedTenant(tid, occ) {
  return withTenant(tid, async (c) => {
    const cap = (await c.query(
      `INSERT INTO resources.capability (tenant_id, name) VALUES ($1,'Violão') RETURNING id`, [tid])).rows[0].id;
    const rid = (await c.query(
      `INSERT INTO resources.resource (tenant_id, type, name, active) VALUES ($1,'TEACHER','Juliano',true) RETURNING id`, [tid])).rows[0].id;
    for (const o of occ) {
      await c.query(
        `INSERT INTO resources.occupation_history (tenant_id, resource_id, capability_id, weekday, slot_time, slot_end, occupied)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [tid, rid, cap, o.weekday, o.slot_time, o.slot_end || null, o.occupied]);
    }
    return rid;
  });
}

before(async () => {
  // Ter (2): 19–20 e 20–21 ocupado (deve MESCLAR → 19–21). Qui (4): 14–15 ocupado; 15–16 LIVRE (não pinta).
  ridA = await seedTenant(TENANT_A, [
    { weekday: 2, slot_time: '19:00', slot_end: '20:00', occupied: true },
    { weekday: 2, slot_time: '20:00', slot_end: '21:00', occupied: true },
    { weekday: 4, slot_time: '14:00', slot_end: '15:00', occupied: true },
    { weekday: 4, slot_time: '15:00', slot_end: '16:00', occupied: false },
  ]);
  ridB = await seedTenant(TENANT_B, [
    { weekday: 3, slot_time: '10:00', slot_end: '11:00', occupied: true },
  ]);

  const app = express();
  app.use('/tenant', require('../src/routes/resources'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.end();
});

test('ocupação do recurso A: mescla adjacentes e ignora slot livre', async () => {
  const { status, json } = await getJSON(`/tenant/${TENANT_A}/resources/${ridA}/ocupacao-recorrente`);
  assert.equal(status, 200);
  assert.deepEqual(json.ocupacao, [
    { weekday: 2, inicio: '19:00', fim: '21:00' }, // 19–20 + 20–21 mesclados
    { weekday: 4, inicio: '14:00', fim: '15:00' }, // 15–16 livre não entra
  ]);
});

test('CROSS-TENANT = 0: recurso de A é invisível a B (404), e vice-versa', async () => {
  // pedir a ocupação do recurso de A ESCOPADO ao tenant B → RLS esconde o recurso → 404.
  const r1 = await getJSON(`/tenant/${TENANT_B}/resources/${ridA}/ocupacao-recorrente`);
  assert.equal(r1.status, 404, 'B não enxerga o recurso de A');
  const r2 = await getJSON(`/tenant/${TENANT_A}/resources/${ridB}/ocupacao-recorrente`);
  assert.equal(r2.status, 404, 'A não enxerga o recurso de B');
});

test('recurso B só devolve a ocupação de B', async () => {
  const { status, json } = await getJSON(`/tenant/${TENANT_B}/resources/${ridB}/ocupacao-recorrente`);
  assert.equal(status, 200);
  assert.deepEqual(json.ocupacao, [{ weekday: 3, inicio: '10:00', fim: '11:00' }]);
});

test('resourceId inválido → 400', async () => {
  const { status } = await getJSON(`/tenant/${TENANT_A}/resources/nao-e-uuid/ocupacao-recorrente`);
  assert.equal(status, 400);
});
