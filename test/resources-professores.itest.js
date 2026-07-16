'use strict';

// Testes de INTEGRAÇÃO do endpoint GET /tenant/:tid/resources/professores (aditivo, leitura).
// Sobe o router real (src/routes/resources.js) num Express efêmero, autentica com token de
// SERVIÇO e exercita contra um Postgres DESCARTÁVEL com a migration 046 (RLS FORCE). Semeia
// professores (type='TEACHER') em DOIS tenants e PROVA o isolamento: cada tenant só enxerga os
// seus; cross-tenant = 0. NUNCA toca produção.
//
// Provisão: test/run-resources-professores-itest.sh (sobe PG, bootstrap + 046, exporta envs).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool, withTenant } = require('../src/db');

const TENANT_A = process.env.RESOURCES_TENANT_A;
const TENANT_B = process.env.RESOURCES_TENANT_B;
const TOKEN = jwt.sign({ role: 'service', service: 'itest' }, process.env.JWT_SECRET);

// Professores por tenant (nomes fora de ordem alfabética p/ provar o ORDER BY name).
const PROFS_A = ['Zeca', 'Ana', 'Marcos'];
const PROFS_B = ['Bianca', 'Otavio'];

let server;
let base;

function getJSON(path) {
  return new Promise((resolve, reject) => {
    http.get(`${base}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(body || '{}') }));
    }).on('error', reject);
  });
}

const seed = (tid, nomes, active = true) => withTenant(tid, async (c) => {
  for (const nome of nomes) {
    await c.query(
      `INSERT INTO resources.resource (tenant_id, type, name, active) VALUES ($1,'TEACHER',$2,$3)`,
      [tid, nome, active]);
  }
});

before(async () => {
  await seed(TENANT_A, PROFS_A);
  await seed(TENANT_B, PROFS_B);
  await seed(TENANT_A, ['Inativo Ignorado'], false); // não deve aparecer (active=false)
  // Uma SALA em A p/ provar que o endpoint só traz TEACHER, não ROOM.
  await withTenant(TENANT_A, (c) => c.query(
    `INSERT INTO resources.resource (tenant_id, type, name, active) VALUES ($1,'ROOM','Sala 1',true)`, [TENANT_A]));

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

test('tenant A só enxerga os professores de A (ativos, ordenados por nome)', async () => {
  const { status, json } = await getJSON(`/tenant/${TENANT_A}/resources/professores`);
  assert.equal(status, 200);
  const nomes = json.professores.map((p) => p.nome);
  assert.deepEqual(nomes, ['Ana', 'Marcos', 'Zeca']); // ORDER BY name; sem inativo, sem sala
  for (const p of json.professores) {
    assert.ok(p.id && typeof p.id === 'string', 'cada professor tem id');
    assert.ok(!('name' in p), 'shape {id, nome} — sem name cru');
  }
});

test('tenant B só enxerga os professores de B', async () => {
  const { status, json } = await getJSON(`/tenant/${TENANT_B}/resources/professores`);
  assert.equal(status, 200);
  assert.deepEqual(json.professores.map((p) => p.nome), ['Bianca', 'Otavio']);
});

test('CROSS-TENANT = 0: nenhum professor de B vaza pra A (e vice-versa)', async () => {
  const a = (await getJSON(`/tenant/${TENANT_A}/resources/professores`)).json.professores;
  const b = (await getJSON(`/tenant/${TENANT_B}/resources/professores`)).json.professores;
  const idsB = new Set(b.map((p) => p.id));
  const idsA = new Set(a.map((p) => p.id));
  assert.equal(a.filter((p) => idsB.has(p.id)).length, 0, 'A não contém nenhum id de B');
  assert.equal(b.filter((p) => idsA.has(p.id)).length, 0, 'B não contém nenhum id de A');
  // e por nome, defensivamente
  assert.equal(a.filter((p) => PROFS_B.includes(p.nome)).length, 0);
  assert.equal(b.filter((p) => PROFS_A.includes(p.nome)).length, 0);
});
