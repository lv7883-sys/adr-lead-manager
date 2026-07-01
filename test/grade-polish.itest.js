'use strict';

// Testes de INTEGRAÇÃO do POLISH da grade-recorrente (feat/grade-polish-backend):
//   (A) NOMES por vão: cada vão traz profs_livres_nomes / salas_livres_nomes (além da contagem).
//   (B) BRANCO CLASSIFICADO: subvãos SEM vão, dentro do expediente, viram buracos[{weekday,inicio,
//       fim,motivo}] com motivo ∈ sem_professor | sem_sala | sem_ambos. vãos ∪ buracos = 100% do
//       expediente (sem furo nem overlap), inclusive em dia SEM professor nenhum.
// Sobe o router real num Express efêmero, token de SERVIÇO, contra Postgres DESCARTÁVEL (046+048+050).
// Sem Extranet, sem produção. Provisão: test/run-grade-polish-itest.sh. weekday ISO 1=seg..6=sáb.
// EXPEDIENTE TENANT_A: seg–sex 09:00–22:00, sáb 09:00–13:00.

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

async function api(path) {
  const res = await fetch(base + path, { headers: { authorization: `Bearer ${TOKEN}` } });
  const txt = await res.text();
  return { status: res.status, json: txt ? JSON.parse(txt) : null };
}

const cap = async (ref, name) => (await q(`INSERT INTO resources.capability (tenant_id, external_ref, name) VALUES ($1,$2,$3) RETURNING id`, [TENANT_A, ref, name]))[0].id;
const resource = async (type, ref, name) => (await q(
  `INSERT INTO resources.resource (tenant_id, type, external_ref, name, attributes)
   VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
  [TENANT_A, type, ref, name, JSON.stringify(type === 'ROOM' ? { apelido: name } : {})]))[0].id;
const link = (r, c) => q(`INSERT INTO resources.resource_capability (tenant_id, resource_id, capability_id) VALUES ($1,$2,$3)`, [TENANT_A, r, c]);
const avail = (r, wd, s, e) => q(`INSERT INTO resources.resource_availability (tenant_id, resource_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4,$5)`, [TENANT_A, r, wd, s, e]);
const occ = (r, wd, slot, end) => q(
  `INSERT INTO resources.occupation_history (tenant_id, resource_id, capability_id, weekday, slot_time, slot_end, occupied)
        VALUES ($1,$2,$3,$4,$5::time,$6::time,true)`,
  [TENANT_A, r, ids.bateria, wd, slot, end]);

const toMin = (t) => { const [h, m] = t.split(':'); return Number(h) * 60 + Number(m); };
const grade = (cp = 'cap:bateria') => api(`/tenant/${TENANT_A}/resources/grade-recorrente?capability=${cp}`);
const diaBuracos = (bs, wd) => bs.filter((b) => b.weekday === wd).map((b) => ({ faixa: `${b.inicio}-${b.fim}`, motivo: b.motivo }));
const diaVaos = (vs, wd) => vs.filter((v) => v.weekday === wd).map((v) => ({ faixa: `${v.inicio}-${v.fim}`, p: v.profs_livres, s: v.salas_livres }));

// vãos ∪ buracos cobrem [expIni, expFim) sem furo nem overlap?
function coberturaOk(json, wd, expIni, expFim) {
  const items = [
    ...json.vaos.filter((v) => v.weekday === wd).map((v) => ({ ini: v.inicio, fim: v.fim })),
    ...json.buracos.filter((b) => b.weekday === wd).map((b) => ({ ini: b.inicio, fim: b.fim })),
  ].sort((a, b) => toMin(a.ini) - toMin(b.ini));
  if (!items.length) return false;
  if (items[0].ini !== expIni) return false;
  for (let i = 0; i < items.length - 1; i++) if (items[i].fim !== items[i + 1].ini) return false;
  return items[items.length - 1].fim === expFim;
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/tenant', require('../src/routes/resources'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  ids.bateria = await cap('cap:bateria', 'Bateria');
  ids.r7 = await resource('ROOM', '7', 'Sala 7');
  ids.r8 = await resource('ROOM', '8', 'Sala 8');
  ids.r9 = await resource('ROOM', '9', 'Sala 9');
  ids.pa = await resource('TEACHER', 'TA', 'Baterista A');
  ids.pb = await resource('TEACHER', 'TB', 'Baterista B');
  for (const r of [ids.r7, ids.r8, ids.r9, ids.pa, ids.pb]) await link(r, ids.bateria);

  // wd1 (seg) — VÃO com nomes + BURACO sem_sala. PA 14–16, PB 15–16; 3 salas ocupadas 14–15.
  //   09–14 sem_professor · 14–15 sem_sala (prof livre, 0 sala) · 15–16 VÃO (2 profs, 3 salas) · 16–22 sem_professor.
  await avail(ids.pa, 1, '14:00', '16:00');
  await avail(ids.pb, 1, '15:00', '16:00');
  for (const r of [ids.r7, ids.r8, ids.r9]) await occ(r, 1, '14:00', '15:00');

  // wd2 (ter) — DIA SEM PROFESSOR NENHUM: nada de avail. Expediente inteiro vira 1 buraco sem_professor.
  //   (prova que a varredura percorre o EXPEDIENTE, não só profAvailByDay.)

  // wd3 (qua) — BURACO sem_ambos. PA 14–16; 3 salas ocupadas 10–11 (onde não há professor).
  //   09–10 sem_professor · 10–11 sem_ambos (0 prof, 0 sala) · 11–14 sem_professor · 14–16 VÃO · 16–22 sem_professor.
  await avail(ids.pa, 3, '14:00', '16:00');
  for (const r of [ids.r7, ids.r8, ids.r9]) await occ(r, 3, '10:00', '11:00');
});

after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

// ---------------------------------------------------------------------------
test('A. NOMES por vão: seg 15:00–16:00 traz profs_livres_nomes e salas_livres_nomes corretos', async () => {
  const { json } = await grade();
  const v = json.vaos.find((x) => x.weekday === 1 && x.inicio === '15:00');
  assert.ok(v, 'esperava vão seg 15:00–16:00');
  assert.deepEqual([...v.profs_livres_nomes].sort(), ['Baterista A', 'Baterista B']);
  assert.deepEqual([...v.salas_livres_nomes].sort(), ['Sala 7', 'Sala 8', 'Sala 9']);
});

test('A2. retrocompat: profs_livres/salas_livres (contagem) ainda presentes no vão', async () => {
  const { json } = await grade();
  const v = json.vaos.find((x) => x.weekday === 1 && x.inicio === '15:00');
  assert.equal(v.profs_livres, 2);
  assert.equal(v.salas_livres, 3);
});

test('B1. BURACO sem_sala: prof livre 14–15 mas 3 salas ocupadas → motivo sem_sala', async () => {
  const { json } = await grade();
  const b = json.buracos.find((x) => x.weekday === 1 && x.inicio === '14:00' && x.fim === '15:00');
  assert.ok(b, 'esperava buraco seg 14:00–15:00');
  assert.equal(b.motivo, 'sem_sala');
});

test('B2. BURACO sem_professor: 0 prof, ≥1 sala (seg 09–14 e 16–22) → motivo sem_professor', async () => {
  const { json } = await grade();
  const manha = json.buracos.find((x) => x.weekday === 1 && x.inicio === '09:00');
  const noite = json.buracos.find((x) => x.weekday === 1 && x.fim === '22:00');
  assert.deepEqual([manha.faixa || `${manha.inicio}-${manha.fim}`, manha.motivo], ['09:00-14:00', 'sem_professor']);
  assert.equal(noite.motivo, 'sem_professor');
});

test('B3. BURACO sem_ambos: qua 10–11 sem professor e 3 salas ocupadas → motivo sem_ambos', async () => {
  const { json } = await grade();
  const b = json.buracos.find((x) => x.weekday === 3 && x.inicio === '10:00' && x.fim === '11:00');
  assert.ok(b, 'esperava buraco qua 10:00–11:00');
  assert.equal(b.motivo, 'sem_ambos');
});

test('B4. seg — conjunto EXATO de buracos (sem_professor / sem_sala / sem_professor)', async () => {
  const { json } = await grade();
  assert.deepEqual(diaBuracos(json.buracos, 1), [
    { faixa: '09:00-14:00', motivo: 'sem_professor' },
    { faixa: '14:00-15:00', motivo: 'sem_sala' },
    { faixa: '16:00-22:00', motivo: 'sem_professor' },
  ]);
  assert.deepEqual(diaVaos(json.vaos, 1), [{ faixa: '15:00-16:00', p: 2, s: 3 }]);
});

test('B5. DIA SEM PROFESSOR (ter): expediente 09–22 inteiro é UM buraco sem_professor (varre o expediente, não só profAvailByDay)', async () => {
  const { json } = await grade();
  assert.deepEqual(diaBuracos(json.buracos, 2), [{ faixa: '09:00-22:00', motivo: 'sem_professor' }]);
  assert.deepEqual(diaVaos(json.vaos, 2), []);
});

test('C. COBERTURA: vãos ∪ buracos = todo o expediente (09:00–22:00), sem furo nem overlap', async () => {
  const { json } = await grade();
  for (const wd of [1, 2, 3]) assert.equal(coberturaOk(json, wd, '09:00', '22:00'), true, `weekday ${wd} não cobre o expediente`);
});

test('D. ISOLAMENTO RLS: tenant B não vê a grade de A → 404', async () => {
  const res = await api(`/tenant/${TENANT_B}/resources/grade-recorrente?capability=cap:bateria`);
  assert.equal(res.status, 404);
});
