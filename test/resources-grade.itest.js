'use strict';

// Testes de INTEGRAÇÃO da GRADE RECORRENTE (vãos) sob o NOVO modelo: a SALA não tem agenda
// própria (a Extranet só dá horário de PROFESSOR). A disponibilidade recorrente da sala = o
// EXPEDIENTE do tenant (horário de atendimento por-dia). Um vão existe onde há ≥1 PROFESSOR
// compatível livre, DENTRO do expediente do dia, havendo ≥1 SALA compatível (a sala conta livre
// em todo o expediente; salas_livres = nº de salas compatíveis). Sobe o router real num Express
// efêmero, autentica com token de SERVIÇO e exercita GET /grade-recorrente contra um Postgres
// DESCARTÁVEL (migration 046 + expediente semeado). NUNCA toca produção nem a Extranet.
//
// Provisão: test/run-resources-grade-itest.sh (semeia o expediente do TENANT_A).
// weekday ISO (CHECK 1..7 de resource_availability / chave do horário): 1=seg … 6=sáb, 7=dom.
// EXPEDIENTE semeado p/ TENANT_A: seg–sex 09:00–22:00, sáb 09:00–13:00, dom fechado.

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
  ids.capCanto = await cap(TENANT_A, 'cap:canto', 'Canto'); // cap só com prof (sem sala)

  ids.pg1 = await resource(TENANT_A, 'TEACHER', 'T1', 'Prof Guitarra 1');
  ids.pg2 = await resource(TENANT_A, 'TEACHER', 'T2', 'Prof Guitarra 2');
  // Salas Cordas: SEM resource_availability (a sala não tem agenda própria — vale o expediente).
  ids.rg1 = await resource(TENANT_A, 'ROOM', '4', 'Sala 4 (Cordas)');
  ids.rg2 = await resource(TENANT_A, 'ROOM', '5', 'Sala 5 (Cordas)');
  for (const r of [ids.pg1, ids.pg2, ids.rg1, ids.rg2]) await link(TENANT_A, r, ids.capGuitarra);

  // seg(1): PG1 08–12, PG2 10–12. Expediente seg 09–22.
  //   → 08:00–09:00 cai FORA do expediente (clip) → some; 09:00–10:00 (1 prof) + 10:00–12:00 (2 profs).
  await avail(TENANT_A, ids.pg1, 1, '08:00', '12:00');
  await avail(TENANT_A, ids.pg2, 1, '10:00', '12:00');

  // sáb(6): PG1 14–16, mas expediente sáb é 09–13 → professor FORA do expediente → SEM vão.
  await avail(TENANT_A, ids.pg1, 6, '14:00', '16:00');

  // CANTO: 1 prof livre seg 09–12, NENHUMA sala compatível → grade sem vãos (sem lugar físico).
  ids.pc1 = await resource(TENANT_A, 'TEACHER', 'T9', 'Prof Canto');
  await link(TENANT_A, ids.pc1, ids.capCanto);
  await avail(TENANT_A, ids.pc1, 1, '09:00', '12:00');

  // ---- TENANT B (isolamento) ---- vazio de propósito.
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

// ---------------------------------------------------------------------------
test('1. DEIXOU DE SER 0: cap com profs + ≥1 sala + expediente → grade retorna vãos', async () => {
  const { status, json } = await api('GET', `/tenant/${TENANT_A}/resources/grade-recorrente?capability=cap:guitarra`);
  assert.equal(status, 200);
  assert.equal(json.professores.length, 2);
  assert.equal(json.salas.length, 2);
  assert.ok(json.vaos.length > 0, 'esperava ≥1 vão (antes do fix vinha 0 por falta de availability de sala)');
});

test('2. EXPEDIENTE recorta o professor: seg PG1 livre 08:00, mas expediente começa 09:00 → 08:00 não é vão', async () => {
  const { json } = await api('GET', `/tenant/${TENANT_A}/resources/grade-recorrente?capability=cap:guitarra`);
  // seg subdividido por folga, já recortado pelo expediente (nada antes das 09:00).
  assert.deepEqual(diaVaos(json.vaos, 1), [
    { faixa: '09:00-10:00', p: 1, s: 2 },
    { faixa: '10:00-12:00', p: 2, s: 2 },
  ]);
  assert.equal(json.vaos.some((v) => v.weekday === 1 && v.inicio < '09:00'), false);
});

test('3. SÁBADO fora do expediente: prof livre sáb 14:00, expediente sáb 09–13 → SEM vão', async () => {
  const { json } = await api('GET', `/tenant/${TENANT_A}/resources/grade-recorrente?capability=cap:guitarra`);
  assert.deepEqual(diaVaos(json.vaos, 6), []);
});

test('4. capability SEM sala compatível → professores listados, mas vaos vazio (sem lugar físico)', async () => {
  const { status, json } = await api('GET', `/tenant/${TENANT_A}/resources/grade-recorrente?capability=cap:canto`);
  assert.equal(status, 200);
  assert.equal(json.professores.length, 1);
  assert.equal(json.salas.length, 0);
  assert.deepEqual(json.vaos, []);
});

test('5. DESMARCAR todas as salas (filtro salas vazio) → 0 vãos', async () => {
  const { status, json } = await api('GET', `/tenant/${TENANT_A}/resources/grade-recorrente?capability=cap:guitarra&salas=`);
  assert.equal(status, 200);
  assert.ok(json.salas.every((s) => s.selecionado === false));
  assert.deepEqual(json.vaos, []);
});

test('6. FOLGA: salas_livres = nº de salas compatíveis (constante); profs_livres varia por subvão', async () => {
  const { json } = await api('GET', `/tenant/${TENANT_A}/resources/grade-recorrente?capability=cap:guitarra`);
  const seg = json.vaos.filter((v) => v.weekday === 1);
  assert.ok(seg.every((v) => v.salas_livres === 2), 'salas_livres deve ser o nº de salas compatíveis (2)');
  assert.deepEqual(seg.map((v) => v.profs_livres), [1, 2], 'profs_livres varia por subvão (sweep line)');
});

test('7. filtro professores=PG1 → some a fronteira das 10h; vira 1 vão 09:00–12:00 (1/2)', async () => {
  const { json } = await api('GET',
    `/tenant/${TENANT_A}/resources/grade-recorrente?capability=cap:guitarra&professores=${ids.pg1}`);
  const sel = Object.fromEntries(json.professores.map((p) => [p.id, p.selecionado]));
  assert.equal(sel[ids.pg1], true);
  assert.equal(sel[ids.pg2], false);
  assert.deepEqual(diaVaos(json.vaos, 1), [{ faixa: '09:00-12:00', p: 1, s: 2 }]);
});

test('8. janela (eixos) = moldura do EXPEDIENTE do tenant (seg–sáb, 09:00–22:00)', async () => {
  const { json } = await api('GET', `/tenant/${TENANT_A}/resources/grade-recorrente?capability=cap:guitarra`);
  assert.equal(json.janela.weekday_min, 1);
  assert.equal(json.janela.weekday_max, 6);
  assert.equal(json.janela.hora_min, '09:00');
  assert.equal(json.janela.hora_max, '22:00');
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
