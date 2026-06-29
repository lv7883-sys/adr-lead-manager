'use strict';

// Testes de INTEGRAÇÃO da GRADE RECORRENTE (vãos com FOLGA = concorrência real, subdivididos no
// sweep line) + o limite multi-slot da rota ao vivo (validação 400, pré-Extranet). Sobe o router
// real num Express efêmero, autentica com token de SERVIÇO e exercita GET /grade-recorrente
// contra um Postgres DESCARTÁVEL (migration 046). NUNCA toca produção nem a Extranet.
//
// Provisão: test/run-resources-grade-itest.sh.
// weekday ISO (CHECK 1..7 de resource_availability): 1=seg … 6=sáb, 7=dom.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool, withTenant } = require('../src/db');

const TENANT_A = process.env.RESOURCES_TENANT_A;
const TENANT_B = process.env.RESOURCES_TENANT_B;
const TOKEN = jwt.sign({ role: 'service', service: 'itest' }, process.env.JWT_SECRET);

let server, base;
const ids = {};

const q = (sql, params, tid = TENANT_A) => withTenant(tid, (c) => c.query(sql, params)).then((r) => r.rows);

async function api(method, path) {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}` } });
  let json = null;
  const txt = await res.text();
  if (txt) { try { json = JSON.parse(txt); } catch { /* não-JSON */ } }
  return { status: res.status, json };
}

// helpers de seed
async function cap(tenant, ref, name) {
  return (await q(`INSERT INTO resources.capability (tenant_id, external_ref, name) VALUES ($1,$2,$3) RETURNING id`,
    [tenant, ref, name], tenant))[0].id;
}
async function resource(tenant, type, ref, name) {
  return (await q(
    `INSERT INTO resources.resource (tenant_id, type, external_ref, name, attributes)
     VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
    [tenant, type, ref, name, JSON.stringify(type === 'ROOM' ? { apelido: name } : {})], tenant))[0].id;
}
const link = (tenant, r, c) => q(`INSERT INTO resources.resource_capability (tenant_id, resource_id, capability_id) VALUES ($1,$2,$3)`, [tenant, r, c], tenant);
const avail = (tenant, r, wd, s, e) => q(`INSERT INTO resources.resource_availability (tenant_id, resource_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4,$5)`, [tenant, r, wd, s, e], tenant);
// vãos de um weekday como pares "inicio-fim" + folga, p/ asserção legível.
const diaVaos = (vs, wd) => vs.filter((v) => v.weekday === wd).map((v) => ({ faixa: `${v.inicio}-${v.fim}`, p: v.profs_livres, s: v.salas_livres }));

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/tenant', require('../src/routes/resources'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // ---- TENANT A ----
  ids.capGuitarra = await cap(TENANT_A, 'cap:guitarra', 'Guitarra');
  ids.capSozinho = await cap(TENANT_A, 'cap:canto', 'Canto'); // cap só com prof (sem sala)

  ids.pg1 = await resource(TENANT_A, 'TEACHER', 'T1', 'Prof Guitarra 1');
  ids.pg2 = await resource(TENANT_A, 'TEACHER', 'T2', 'Prof Guitarra 2');
  ids.rg1 = await resource(TENANT_A, 'ROOM', '1', 'Sala 1');
  ids.rg2 = await resource(TENANT_A, 'ROOM', '2', 'Sala 2');
  for (const r of [ids.pg1, ids.pg2, ids.rg1, ids.rg2]) await link(TENANT_A, r, ids.capGuitarra);

  // seg(1) SUBDIVISÃO: PG1 08–12, PG2 08–09 ; salas RG1/RG2 08–12.
  //   → 08:00-09:00 (2 prof/2 sala) + 09:00-12:00 (1 prof/2 sala). NÃO um único 08–12 folga 2.
  await avail(TENANT_A, ids.pg1, 1, '08:00', '12:00');
  await avail(TENANT_A, ids.pg2, 1, '08:00', '09:00');
  await avail(TENANT_A, ids.rg1, 1, '08:00', '12:00');
  await avail(TENANT_A, ids.rg2, 1, '08:00', '12:00');

  // ter(2) BURACO: PG1 08–12 ; salas RG1 08–09 e RG2 10–12 (nada às 09–10).
  //   → 08:00-09:00 (1/1) + 10:00-12:00 (1/1) ; 09:00-10:00 SEM vão (0 sala).
  await avail(TENANT_A, ids.pg1, 2, '08:00', '12:00');
  await avail(TENANT_A, ids.rg1, 2, '08:00', '09:00');
  await avail(TENANT_A, ids.rg2, 2, '10:00', '12:00');

  // qua(3): só PROF livre (PG1 14–16), nenhuma sala → SEM vão.
  await avail(TENANT_A, ids.pg1, 3, '14:00', '16:00');
  // qui(4): só SALA livre (RG1 14–16), nenhum prof → SEM vão.
  await avail(TENANT_A, ids.rg1, 4, '14:00', '16:00');

  // sex(5): sobreposição PARCIAL — PG1 08–11, RG1 09–12 → vão 09:00-11:00 (1/1).
  await avail(TENANT_A, ids.pg1, 5, '08:00', '11:00');
  await avail(TENANT_A, ids.rg1, 5, '09:00', '12:00');

  // CANTO: 1 prof, NENHUMA sala compatível → grade sem vãos.
  ids.pc1 = await resource(TENANT_A, 'TEACHER', 'T9', 'Prof Canto');
  await link(TENANT_A, ids.pc1, ids.capSozinho);
  await avail(TENANT_A, ids.pc1, 1, '08:00', '12:00');

  // ---- TENANT B (isolamento) ---- vazio de propósito.
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

// ---------------------------------------------------------------------------
test('1. SUBDIVISÃO: prof que sai às 09h reduz a folga real (não infla o vão inteiro)', async () => {
  const { status, json } = await api('GET', `/tenant/${TENANT_A}/resources/grade-recorrente?capability=cap:guitarra`);
  assert.equal(status, 200);
  assert.equal(json.professores.length, 2);
  assert.equal(json.salas.length, 2);

  // seg: dois subvãos com folga constante e REAL — não "08:00-12:00 folga 2".
  assert.deepEqual(diaVaos(json.vaos, 1), [
    { faixa: '08:00-09:00', p: 2, s: 2 },
    { faixa: '09:00-12:00', p: 1, s: 2 },
  ]);
});

test('2. BURACO: sem sala às 09–10 → aquele trecho NÃO vira vão', async () => {
  const { json } = await api('GET', `/tenant/${TENANT_A}/resources/grade-recorrente?capability=cap:guitarra`);
  assert.deepEqual(diaVaos(json.vaos, 2), [
    { faixa: '08:00-09:00', p: 1, s: 1 },
    { faixa: '10:00-12:00', p: 1, s: 1 },
  ]);
  // explícito: nenhum vão cobre 09:00–10:00.
  assert.equal(json.vaos.some((v) => v.weekday === 2 && v.inicio < '10:00' && v.fim > '09:00' && v.inicio >= '09:00'), false);
});

test('3. prof livre sem sala (qua) → SEM vão; sala livre sem prof (qui) → SEM vão', async () => {
  const { json } = await api('GET', `/tenant/${TENANT_A}/resources/grade-recorrente?capability=cap:guitarra`);
  assert.equal(json.vaos.filter((v) => v.weekday === 3).length, 0);
  assert.equal(json.vaos.filter((v) => v.weekday === 4).length, 0);
});

test('4. sobreposição PARCIAL (sex) → vão = interseção 09:00–11:00 (1/1)', async () => {
  const { json } = await api('GET', `/tenant/${TENANT_A}/resources/grade-recorrente?capability=cap:guitarra`);
  assert.deepEqual(diaVaos(json.vaos, 5), [{ faixa: '09:00-11:00', p: 1, s: 1 }]);
});

test('5. filtro professores=PG1 → some a fronteira das 09h; vira 1 vão 08:00–12:00 (1/2)', async () => {
  const { json } = await api('GET',
    `/tenant/${TENANT_A}/resources/grade-recorrente?capability=cap:guitarra&professores=${ids.pg1}`);
  const sel = Object.fromEntries(json.professores.map((p) => [p.id, p.selecionado]));
  assert.equal(sel[ids.pg1], true);
  assert.equal(sel[ids.pg2], false);
  assert.deepEqual(diaVaos(json.vaos, 1), [{ faixa: '08:00-12:00', p: 1, s: 2 }]);
});

test('6. filtro salas=RG1 → salas_livres cai p/ 1 em cada subvão', async () => {
  const { json } = await api('GET',
    `/tenant/${TENANT_A}/resources/grade-recorrente?capability=cap:guitarra&salas=${ids.rg1}`);
  const sel = Object.fromEntries(json.salas.map((s) => [s.id, s.selecionado]));
  assert.equal(sel[ids.rg1], true);
  assert.equal(sel[ids.rg2], false);
  assert.deepEqual(diaVaos(json.vaos, 1), [
    { faixa: '08:00-09:00', p: 2, s: 1 },
    { faixa: '09:00-12:00', p: 1, s: 1 },
  ]);
});

test('7. capability só com prof (sem sala compatível) → professores listados, vaos vazio', async () => {
  const { status, json } = await api('GET', `/tenant/${TENANT_A}/resources/grade-recorrente?capability=cap:canto`);
  assert.equal(status, 200);
  assert.equal(json.professores.length, 1);
  assert.equal(json.salas.length, 0);
  assert.deepEqual(json.vaos, []);
});

test('8. janela (extent) cobre o weekday/hora min–max da disponibilidade', async () => {
  const { json } = await api('GET', `/tenant/${TENANT_A}/resources/grade-recorrente?capability=cap:guitarra`);
  assert.equal(json.janela.weekday_min, 1);
  assert.equal(json.janela.weekday_max, 5);
  assert.equal(json.janela.hora_min, '08:00');
  assert.equal(json.janela.hora_max, '16:00');
});

test('9. capability inexistente → 404', async () => {
  const { status } = await api('GET', `/tenant/${TENANT_A}/resources/grade-recorrente?capability=cap:inexistente`);
  assert.equal(status, 404);
});

test('10. ISOLAMENTO RLS: tenant B não vê a grade de A (por ref e por id) → 404', async () => {
  assert.equal((await api('GET', `/tenant/${TENANT_B}/resources/grade-recorrente?capability=cap:guitarra`)).status, 404);
  assert.equal((await api('GET', `/tenant/${TENANT_B}/resources/grade-recorrente?capability=${ids.capGuitarra}`)).status, 404);
});

test('11. MULTI-SLOT: 4 slots → 400 (validação antes da Extranet)', async () => {
  const slots = '2026-06-30@08:00,2026-06-30@09:00,2026-06-30@10:00,2026-06-30@11:00';
  const { status, json } = await api('GET', `/tenant/${TENANT_A}/resources/ocupacao-ao-vivo?slots=${encodeURIComponent(slots)}`);
  assert.equal(status, 400);
  assert.match(json.error, /máximo de 3/i);
});
