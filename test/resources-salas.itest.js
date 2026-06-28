'use strict';

// Testes de INTEGRAÇÃO da tela de atribuição SALA ↔ CAPABILITY (Unit 1).
// Sobe o router real (src/routes/resources.js) num Express efêmero, autentica com um
// token de SERVIÇO (JWT role=service → requireTenantAccess libera por tenant válido) e
// exercita GET/PUT contra um Postgres DESCARTÁVEL com a migration 046. Semeia 9 salas +
// 22 capabilities direto (sem fixtures/rede). NUNCA toca produção.
//
// Provisão: test/run-resources-salas-itest.sh (sobe PG, bootstrap + 046, exporta envs).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool, withTenant } = require('../src/db');
const valinhos = require('../src/resources/adapters/valinhos');

const TENANT_A = process.env.RESOURCES_TENANT_A;
const TENANT_B = process.env.RESOURCES_TENANT_B;
const TOKEN = jwt.sign({ role: 'service', service: 'itest' }, process.env.JWT_SECRET);

// Vocações das 9 salas (espelha o cadastro real de Valinhos).
const ROOMS = [
  { ref: '1', apelido: 'Rita Lee', vocacao: 'Canto e Teclas' },
  { ref: '2', apelido: 'Yellow Submarine', vocacao: 'Musicalização Infantil' },
  { ref: '3', apelido: 'Freddie Mercury', vocacao: 'Canto e Teclas' },
  { ref: '4', apelido: 'Mark Knopfler', vocacao: 'Cordas' },
  { ref: '5', apelido: 'Van Halen', vocacao: 'Cordas' },
  { ref: '6', apelido: 'Paul McCartney', vocacao: 'Cordas' },
  { ref: '7', apelido: 'Estúdio Slash', vocacao: 'Estúdio' },
  { ref: '8', apelido: 'Estúdio John Bonham', vocacao: 'Estúdio' },
  { ref: '9', apelido: 'Estúdio Principal', vocacao: 'Estúdio' },
];

let server;
let base;
let capByRefA = new Map(); // ref → id (tenant A)
let salaIdByRef = new Map();
let otherTenantCapId; // capability do tenant B (p/ teste de cap alheia)
let teacherIdA;       // resource TEACHER do tenant A (p/ teste de 404)

const q = (sql, params, tid = TENANT_A) => withTenant(tid, (c) => c.query(sql, params)).then((r) => r.rows);

async function api(method, path, { body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const txt = await res.text();
  if (txt) { try { json = JSON.parse(txt); } catch { /* não-JSON */ } }
  return { status: res.status, json };
}

before(async () => {
  // App efêmero com o router REAL montado em /tenant (igual ao server.js).
  const app = express();
  app.use(express.json());
  app.use('/tenant', require('../src/routes/resources'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // binding ATIVO SCRAPE_EXTRANET p/ tenant A (define o de-para de vocação a usar).
  await q(`INSERT INTO resources.resource_source_binding (tenant_id, kind, name, status)
           VALUES ($1, 'SCRAPE_EXTRANET', 'itest', 'ACTIVE')`, [TENANT_A]);

  // 22 capabilities canônicas (refs derivados do MESMO de-para do adapter).
  for (const name of valinhos.CAPABILITIES) {
    await q(`INSERT INTO resources.capability (tenant_id, external_ref, name) VALUES ($1, $2, $3)`,
      [TENANT_A, valinhos.capRef(name), name]);
  }
  for (const r of await q(`SELECT id, external_ref FROM resources.capability`)) capByRefA.set(r.external_ref, r.id);

  // 9 salas (ROOM) + 1 professor (TEACHER) do tenant A.
  for (const r of ROOMS) {
    const row = (await q(
      `INSERT INTO resources.resource (tenant_id, type, external_ref, name, attributes)
       VALUES ($1, 'ROOM', $2, $3, $4::jsonb) RETURNING id`,
      [TENANT_A, r.ref, `Sala ${r.ref} ( ${r.apelido} - ${r.vocacao} )`,
       JSON.stringify({ apelido: r.apelido, vocacao: r.vocacao })]))[0];
    salaIdByRef.set(r.ref, row.id);
  }
  teacherIdA = (await q(
    `INSERT INTO resources.resource (tenant_id, type, external_ref, name)
     VALUES ($1, 'TEACHER', 'T1', 'Professor Teste') RETURNING id`, [TENANT_A]))[0].id;

  // tenant B: 1 capability própria (p/ provar rejeição de cap de outro tenant).
  otherTenantCapId = (await q(
    `INSERT INTO resources.capability (tenant_id, external_ref, name)
     VALUES ($1, 'cap:canto', 'Canto') RETURNING id`, [TENANT_B], TENANT_B))[0].id;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

// ---------------------------------------------------------------------------
test('1. GET /salas → 9 salas com estados SUGERIDA/EM_BRANCO e 22 capabilities', async () => {
  const { status, json } = await api('GET', `/tenant/${TENANT_A}/resources/salas`);
  assert.equal(status, 200);
  assert.equal(json.salas.length, 9, '9 salas');
  assert.equal(json.capabilities.length, 22, '22 capabilities (chips)');

  const byNum = Object.fromEntries(json.salas.map((s) => [s.numero, s]));
  const refs = (s) => s.sugeridas.map((c) => c.external_ref).sort();

  // 1 e 3 (Canto e Teclas) → SUGERIDA: canto, teclado, piano
  for (const n of ['1', '3']) {
    assert.equal(byNum[n].estado, 'SUGERIDA', `sala ${n} SUGERIDA`);
    assert.deepEqual(refs(byNum[n]), ['cap:canto', 'cap:piano', 'cap:teclado']);
    assert.equal(byNum[n].atribuidas.length, 0);
  }
  // 2 (Musicalização Infantil) → SUGERIDA: musicalizacao, inicializacao-musical
  assert.equal(byNum['2'].estado, 'SUGERIDA');
  assert.deepEqual(refs(byNum['2']), ['cap:inicializacao-musical', 'cap:musicalizacao']);
  // 4,5,6 (Cordas) → SUGERIDA: violao, guitarra, baixo, ukulele
  for (const n of ['4', '5', '6']) {
    assert.equal(byNum[n].estado, 'SUGERIDA', `sala ${n} SUGERIDA`);
    assert.deepEqual(refs(byNum[n]), ['cap:baixo', 'cap:guitarra', 'cap:ukulele', 'cap:violao']);
  }
  // 7,8,9 (Estúdio) → EM_BRANCO (sem sugestão)
  for (const n of ['7', '8', '9']) {
    assert.equal(byNum[n].estado, 'EM_BRANCO', `sala ${n} EM_BRANCO`);
    assert.equal(byNum[n].sugeridas.length, 0);
  }

  // shape: número/apelido/vocação separados.
  assert.equal(byNum['1'].apelido, 'Rita Lee');
  assert.equal(byNum['1'].vocacao_extranet, 'Canto e Teclas');
});

test('2. PUT grava o set → GET reflete ATRIBUIDA', async () => {
  const sala1 = salaIdByRef.get('1');
  const ids = [capByRefA.get('cap:canto'), capByRefA.get('cap:piano')];
  const put = await api('PUT', `/tenant/${TENANT_A}/resources/salas/${sala1}/capabilities`, { body: { capability_ids: ids } });
  assert.equal(put.status, 200);
  assert.equal(put.json.estado, 'ATRIBUIDA');
  assert.equal(put.json.atribuidas.length, 2);

  const { json } = await api('GET', `/tenant/${TENANT_A}/resources/salas`);
  const s1 = json.salas.find((s) => s.numero === '1');
  assert.equal(s1.estado, 'ATRIBUIDA');
  assert.deepEqual(s1.atribuidas.map((c) => c.external_ref).sort(), ['cap:canto', 'cap:piano']);
});

test('3. PUT é REPLACE (set novo substitui o anterior)', async () => {
  const sala1 = salaIdByRef.get('1');
  const put = await api('PUT', `/tenant/${TENANT_A}/resources/salas/${sala1}/capabilities`,
    { body: { capability_ids: [capByRefA.get('cap:teclado')] } });
  assert.equal(put.status, 200);
  assert.equal(put.json.atribuidas.length, 1);
  assert.equal(put.json.atribuidas[0].external_ref, 'cap:teclado');

  const { json } = await api('GET', `/tenant/${TENANT_A}/resources/salas`);
  const s1 = json.salas.find((s) => s.numero === '1');
  assert.deepEqual(s1.atribuidas.map((c) => c.external_ref), ['cap:teclado']);
});

test('4. PUT [] limpa → volta a SUGERIDA (sala c/ sugestão) e EM_BRANCO (sala sem)', async () => {
  const sala1 = salaIdByRef.get('1');     // Canto e Teclas → tem sugestão
  const put1 = await api('PUT', `/tenant/${TENANT_A}/resources/salas/${sala1}/capabilities`, { body: { capability_ids: [] } });
  assert.equal(put1.status, 200);
  assert.equal(put1.json.atribuidas.length, 0);
  assert.equal(put1.json.estado, 'SUGERIDA', 'sala com sugestão volta a SUGERIDA ao limpar');

  const sala7 = salaIdByRef.get('7');     // Estúdio → sem sugestão
  await api('PUT', `/tenant/${TENANT_A}/resources/salas/${sala7}/capabilities`, { body: { capability_ids: [capByRefA.get('cap:gravacao')] } });
  const put7 = await api('PUT', `/tenant/${TENANT_A}/resources/salas/${sala7}/capabilities`, { body: { capability_ids: [] } });
  assert.equal(put7.json.estado, 'EM_BRANCO', 'sala sem sugestão fica EM_BRANCO ao limpar');
});

test('5. PUT com capability de OUTRO tenant → 400', async () => {
  const sala1 = salaIdByRef.get('1');
  const put = await api('PUT', `/tenant/${TENANT_A}/resources/salas/${sala1}/capabilities`,
    { body: { capability_ids: [otherTenantCapId] } });
  assert.equal(put.status, 400);
  assert.match(put.json.error, /capability inválida|outro tenant/i);
  // E não gravou nada (RLS + validação antes do INSERT).
  const { json } = await api('GET', `/tenant/${TENANT_A}/resources/salas`);
  assert.equal(json.salas.find((s) => s.numero === '1').atribuidas.length, 0);
});

test('6. PUT em resource TEACHER (não-ROOM) → 404', async () => {
  const put = await api('PUT', `/tenant/${TENANT_A}/resources/salas/${teacherIdA}/capabilities`,
    { body: { capability_ids: [capByRefA.get('cap:canto')] } });
  assert.equal(put.status, 404);
  assert.match(put.json.error, /sala não encontrada/i);
});

test('7. ISOLAMENTO RLS: tenant B não enxerga as salas de A (GET 0; PUT 404)', async () => {
  const getB = await api('GET', `/tenant/${TENANT_B}/resources/salas`);
  assert.equal(getB.status, 200);
  assert.equal(getB.json.salas.length, 0, 'B não vê salas de A');

  const sala1A = salaIdByRef.get('1');
  const putB = await api('PUT', `/tenant/${TENANT_B}/resources/salas/${sala1A}/capabilities`,
    { body: { capability_ids: [] } });
  assert.equal(putB.status, 404, 'B não enxerga (nem altera) o ROOM de A');
});

test('8. ROOM sem attributes.vocacao → GET não lança; EM_BRANCO, sugeridas []', async () => {
  // Tenant nativo (sem Extranet) não tem vocação: a sala não pode estourar o GET
  // all-or-nothing. Semeada AQUI (não no before) p/ não alterar a contagem dos testes 1–7.
  const novo = (await q(
    `INSERT INTO resources.resource (tenant_id, type, external_ref, name, attributes)
     VALUES ($1, 'ROOM', '99', 'Sala 99 ( sem vocação )', $2::jsonb) RETURNING id`,
    [TENANT_A, JSON.stringify({ apelido: 'Sem Vocação' })]))[0]; // attributes SEM 'vocacao'

  const { status, json } = await api('GET', `/tenant/${TENANT_A}/resources/salas`);
  assert.equal(status, 200, 'GET não lança com sala sem vocacao');
  const sala = json.salas.find((s) => s.id === novo.id);
  assert.ok(sala, 'a sala sem vocação aparece na lista');
  assert.equal(sala.vocacao_extranet, null, 'vocacao_extranet null');
  assert.deepEqual(sala.sugeridas, [], 'sem sugestão (adapter não tem palpite)');
  assert.equal(sala.estado, 'EM_BRANCO');
});
