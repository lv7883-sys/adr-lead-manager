'use strict';

// Testes de INTEGRAÇÃO da grade-recorrente DESCONTANDO ocupação real (Frente A — passo 2).
// disponibilidade = expediente − ocupação. occupation_history (ROOM e TEACHER) com slot_end traz
// a ocupação vigente; a grade desconta os intervalos [slot_time, slot_end). Sobe o router real
// num Express efêmero, token de SERVIÇO, contra Postgres DESCARTÁVEL (046+048+050). Sem Extranet.
//
// Provisão: test/run-grade-desconta-ocupacao-itest.sh. weekday ISO 1=seg..6=sáb.
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
const resource = async (type, ref, name) => (await q(`INSERT INTO resources.resource (tenant_id, type, external_ref, name) VALUES ($1,$2,$3,$4) RETURNING id`, [TENANT_A, type, ref, name]))[0].id;
const link = (r, c) => q(`INSERT INTO resources.resource_capability (tenant_id, resource_id, capability_id) VALUES ($1,$2,$3)`, [TENANT_A, r, c]);
const avail = (r, wd, s, e) => q(`INSERT INTO resources.resource_availability (tenant_id, resource_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4,$5)`, [TENANT_A, r, wd, s, e]);
// ocupação: slot_end pode ser null (legado); changedAt explícito p/ o teste de diff.
const occ = (r, wd, slot, end, occupied = true, changedAt = null) => q(
  `INSERT INTO resources.occupation_history (tenant_id, resource_id, capability_id, weekday, slot_time, slot_end, occupied, changed_at)
        VALUES ($1,$2,$3,$4,$5::time,$6::time,$7, COALESCE($8::timestamptz, now()))`,
  [TENANT_A, r, ids.bateria, wd, slot, end, occupied, changedAt]);

const diaVaos = (vs, wd) => vs.filter((v) => v.weekday === wd).map((v) => ({ faixa: `${v.inicio}-${v.fim}`, p: v.profs_livres, s: v.salas_livres }));
const grade = (cp = 'cap:bateria') => api(`/tenant/${TENANT_A}/resources/grade-recorrente?capability=${cp}`);

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/tenant', require('../src/routes/resources'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  ids.bateria = await cap('cap:bateria', 'Bateria');
  ids.r7 = await resource('ROOM', '7', 'Sala 7 ( Estúdio Slash )');
  ids.r8 = await resource('ROOM', '8', 'Sala 8 ( Estúdio John Bonham )');
  ids.r9 = await resource('ROOM', '9', 'Sala 9 ( Estúdio Principal )');
  ids.pa = await resource('TEACHER', 'TA', 'Baterista A');
  ids.pb = await resource('TEACHER', 'TB', 'Baterista B');
  for (const r of [ids.r7, ids.r8, ids.r9, ids.pa, ids.pb]) await link(r, ids.bateria);

  // disponibilidade dos professores (recorrente).
  await avail(ids.pa, 1, '14:00', '19:00');
  await avail(ids.pa, 2, '14:00', '19:00');
  await avail(ids.pa, 3, '14:00', '17:00');
  await avail(ids.pa, 4, '17:00', '19:00');
  await avail(ids.pa, 5, '14:00', '16:00'); await avail(ids.pb, 5, '14:00', '16:00');
  await avail(ids.pa, 6, '10:00', '12:00');

  // wd1 — CASO LEO: 3 estúdios ocupados 14:00-19:00 (slots de 1h) → 0 vão.
  for (const r of [ids.r7, ids.r8, ids.r9]) for (const h of [14, 15, 16, 17, 18]) {
    await occ(r, 1, `${h}:00`, `${h + 1}:00`);
  }

  // wd2 — r8,r9 ocupados 14-19; r7 ocupado 14-15 e 16-19 (LIVRE 15-16) → vão só 15:00-16:00 (s=1).
  for (const r of [ids.r8, ids.r9]) for (const h of [14, 15, 16, 17, 18]) await occ(r, 2, `${h}:00`, `${h + 1}:00`);
  for (const h of [14, 16, 17, 18]) await occ(ids.r7, 2, `${h}:00`, `${h + 1}:00`);

  // wd3 — DURAÇÃO REAL (banda 90min): r8,r9 ocupados 14-17; r7 ocupado 14:00-15:30 (uma linha).
  // → 15:00-15:30 ainda ocupado; vão só a partir de 15:30 (chute de 1h liberaria às 15:00).
  for (const r of [ids.r8, ids.r9]) for (const h of [14, 15, 16]) await occ(r, 3, `${h}:00`, `${h + 1}:00`);
  await occ(ids.r7, 3, '14:00', '15:30');

  // wd4 — 45min: r8,r9 ocupados 17-19; r7 ocupado 17:30-18:15 → 18:00-18:15 ainda ocupado.
  for (const r of [ids.r8, ids.r9]) for (const h of [17, 18]) await occ(r, 4, `${h}:00`, `${h + 1}:00`);
  await occ(ids.r7, 4, '17:30', '18:15');

  // wd5 — PROFESSOR ocupado: pa ocupado 14:00-15:00 (salas todas livres) → profs_livres cai.
  await occ(ids.pa, 5, '14:00', '15:00');

  // wd6 (sáb) — DIFF (estado vigente) + LEGADO slot_end NULL:
  //   r8,r9 ocupados 10:00 com slot_end NULL → fallback [10:00,11:00).
  //   r7: occupied=true (changed_at antigo) e depois occupied=false (changed_at novo) → vigente LIVRE.
  await occ(ids.r8, 6, '10:00', null);
  await occ(ids.r9, 6, '10:00', null);
  await occ(ids.r7, 6, '10:00', '11:00', true, '2026-06-01T00:00:00Z');
  await occ(ids.r7, 6, '10:00', '11:00', false, '2026-06-02T00:00:00Z');
});

after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

// ---------------------------------------------------------------------------
test('1. CASO LEO: prof livre 14-19 mas os 3 estúdios ocupados 14-19 → NENHUM vão (salas_livres=0)', async () => {
  const { json } = await grade();
  assert.deepEqual(diaVaos(json.vaos, 1), []);
});

test('2. 1 estúdio livre 15-16 (outros 2 ocupados) → vão 15:00-16:00 com salas_livres=1', async () => {
  const { json } = await grade();
  assert.deepEqual(diaVaos(json.vaos, 2), [{ faixa: '15:00-16:00', p: 1, s: 1 }]);
});

test('3. DURAÇÃO REAL (banda 90min, 14:00-15:30): 15:00-15:30 ainda ocupado → vão só a partir de 15:30', async () => {
  const { json } = await grade();
  // r7 é a ÚNICA sala livre de 15:30 a 17:00 (r8/r9 ocupados até 17:00); a fronteira às 16:00 era só
  // do slot de r8/r9. Com a fusão (feat/grade-funde-vaos), os subvãos 15:30-16:00 e 16:00-17:00 —
  // mesmo prof, mesma sala r7 o bloco todo — viram UM vão contínuo 15:30-17:00.
  assert.deepEqual(diaVaos(json.vaos, 3), [
    { faixa: '15:30-17:00', p: 1, s: 1 },
  ]);
  // explícito: nada cobre 15:00-15:30 (chute de 1h liberaria r7 às 15:00 e criaria vão aqui).
  assert.equal(json.vaos.some((v) => v.weekday === 3 && v.inicio === '15:00'), false);
});

test('4. aula 45min (17:30-18:15): 18:00-18:15 ainda ocupado → vãos 17:00-17:30 e 18:15-19:00', async () => {
  const { json } = await grade();
  assert.deepEqual(diaVaos(json.vaos, 4), [
    { faixa: '17:00-17:30', p: 1, s: 1 },
    { faixa: '18:15-19:00', p: 1, s: 1 },
  ]);
  assert.equal(json.vaos.some((v) => v.weekday === 4 && v.inicio === '17:30'), false);
});

test('5. PROFESSOR ocupado 14-15 (pb livre o bloco todo, pa entra às 15:00) → funde 14:00-16:00, profs = interseção [pb] (p=1)', async () => {
  const { json } = await grade();
  // pa ocupado 14-15 e livre 15-16; pb livre 14-16. Antes: dois vãos (p1 depois p2). Com a fusão
  // (feat/grade-funde-vaos), como pb está livre o bloco INTEIRO (interseção de profs = {pb} ≥1) e as
  // 3 salas livres o tempo todo, vira UM vão 14:00-16:00 com profs_livres = tamanho da interseção = 1.
  assert.deepEqual(diaVaos(json.vaos, 5), [
    { faixa: '14:00-16:00', p: 1, s: 3 },
  ]);
});

test('6. DIFF (vigente=false) + LEGADO slot_end NULL (fallback 60min): sáb', async () => {
  const { json } = await grade();
  // 10-11: r8,r9 ocupados (legado [10,11)); r7 vigente livre (último registro = false) → s=1.
  // 11-12: legado terminou às 11 → r8,r9 livres; r7 livre → s=3.
  // r7 está livre o bloco todo (interseção de salas = {r7} ≥1), então com a fusão (feat/grade-funde-vaos)
  // os dois subvãos viram UM vão 10:00-12:00 com salas_livres = tamanho da interseção = 1.
  assert.deepEqual(diaVaos(json.vaos, 6), [
    { faixa: '10:00-12:00', p: 1, s: 1 },
  ]);
});

test('7. ISOLAMENTO RLS: tenant B não vê a grade de A → 404', async () => {
  const res = await api(`/tenant/${TENANT_B}/resources/grade-recorrente?capability=cap:bateria`);
  assert.equal(res.status, 404);
});
