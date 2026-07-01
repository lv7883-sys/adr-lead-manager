'use strict';

// Testes de INTEGRAÇÃO da FUSÃO DE VÃOS ADJACENTES na grade-recorrente (feat/grade-funde-vaos).
// A sweep-line fatia um vão CONTÍNUO sempre que a COMPOSIÇÃO de recursos livres muda no meio,
// mesmo continuando a haver vaga (≥1 prof + ≥1 sala). computeVaos agora funde vãos adjacentes
// (mesmo weekday, fim==início) QUANDO há CONTINUIDADE DE RECURSO: interseção de profs livres E de
// salas livres do bloco INTEIRO ≥1. Os nomes/contagem do bloco = a interseção (só quem cobre o
// bloco todo). Sem continuidade real → NÃO funde (folga genuinamente distinta). Transitiva com
// interseção acumulada; quebra a cadeia onde a interseção zera.
//
// Cada CENÁRIO usa sua PRÓPRIA capability (recursos isolados). weekday 5 = sexta.
// Sobe o router real num Express efêmero, token de SERVIÇO, contra Postgres DESCARTÁVEL (046+048+050).
// Sem Extranet, sem produção. Provisão: test/run-grade-funde-vaos-itest.sh.
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

const WD = 5; // sexta
let server, base;
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
const avail = (r, s, e, wd = WD) => q(`INSERT INTO resources.resource_availability (tenant_id, resource_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4,$5)`, [TENANT_A, r, wd, s, e]);
const occ = (r, c, slot, end, wd = WD) => q(
  `INSERT INTO resources.occupation_history (tenant_id, resource_id, capability_id, weekday, slot_time, slot_end, occupied)
        VALUES ($1,$2,$3,$4,$5::time,$6::time,true)`,
  [TENANT_A, r, c, wd, slot, end]);

const grade = (cp) => api(`/tenant/${TENANT_A}/resources/grade-recorrente?capability=${cp}`);
// vãos do weekday WD, resumidos: faixa + nomes ordenados (o que a tela usa no hover).
const vaosWD = (json) => json.vaos.filter((v) => v.weekday === WD)
  .map((v) => ({ faixa: `${v.inicio}-${v.fim}`, profs: [...v.profs_livres_nomes].sort(), salas: [...v.salas_livres_nomes].sort() }))
  .sort((a, b) => a.faixa.localeCompare(b.faixa));

const toMin = (t) => { const [h, m] = t.split(':'); return Number(h) * 60 + Number(m); };
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

const id = {};

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/tenant', require('../src/routes/resources'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // ----- CASO CANTO: funde, sala que não cobre o bloco SAI -----------------------------------
  // prof livre 17–18; salas A,B livres 17–18; sala C livre só 17:00–17:30 (ocupa 17:30–18:00).
  // → UM vão 17:00–18:00 com salas=[A,B] (C fora). Prova a fusão + hover = interseção.
  id.canto = await cap('cap:canto', 'Canto');
  id.cantoA = await resource('ROOM', 'cA', 'Sala A'); await link(id.cantoA, id.canto);
  id.cantoB = await resource('ROOM', 'cB', 'Sala B'); await link(id.cantoB, id.canto);
  id.cantoC = await resource('ROOM', 'cC', 'Sala C'); await link(id.cantoC, id.canto);
  id.cantoP = await resource('TEACHER', 'cP', 'Prof Canto'); await link(id.cantoP, id.canto);
  await avail(id.cantoP, '17:00', '18:00');
  await occ(id.cantoC, id.canto, '17:30', '18:00');

  // ----- NÃO FUNDE: descontinuidade de sala (interseção vazia) --------------------------------
  // prof livre 17–18; sala A livre só 17:00–17:30; sala B livre só 17:30–18:00.
  // → 2 vãos: 17:00–17:30 [A] e 17:30–18:00 [B]. Prova que respeita a descontinuidade.
  id.desc = await cap('cap:desc', 'Desc');
  id.descA = await resource('ROOM', 'dA', 'Desc A'); await link(id.descA, id.desc);
  id.descB = await resource('ROOM', 'dB', 'Desc B'); await link(id.descB, id.desc);
  id.descP = await resource('TEACHER', 'dP', 'Prof Desc'); await link(id.descP, id.desc);
  await avail(id.descP, '17:00', '18:00');
  await occ(id.descA, id.desc, '17:30', '18:00'); // A livre só 17:00–17:30
  await occ(id.descB, id.desc, '17:00', '17:30'); // B livre só 17:30–18:00

  // ----- TRANSITIVA: 3 subvãos, prof+sala comuns aos três → 1 bloco só ------------------------
  // prof livre 17:00–18:30; sala T livre o bloco todo; salas B,C entram/saem criando 2 fronteiras.
  id.trans = await cap('cap:trans', 'Trans');
  id.transT = await resource('ROOM', 'tT', 'Trans T'); await link(id.transT, id.trans); // comum
  id.transB = await resource('ROOM', 'tB', 'Trans B'); await link(id.transB, id.trans);
  id.transC = await resource('ROOM', 'tC', 'Trans C'); await link(id.transC, id.trans);
  id.transP = await resource('TEACHER', 'tP', 'Prof Trans'); await link(id.transP, id.trans);
  await avail(id.transP, '17:00', '18:30');
  await occ(id.transB, id.trans, '17:30', '18:30'); // B livre só 17:00–17:30
  await occ(id.transC, id.trans, '17:00', '18:00'); // C livre só 18:00–18:30
  // subvãos: 17:00–17:30 {T,B} · 17:30–18:00 {T} · 18:00–18:30 {T,C}; interseção dos três = {T}.

  // ----- TRANSITIVA QUEBRA: A-B fundem, C fica separado ---------------------------------------
  // prof livre 17:00–18:30; sala A livre 17:00–18:00; sala B livre 17:30–18:30.
  id.tbrk = await cap('cap:tbrk', 'TBrk');
  id.tbrkA = await resource('ROOM', 'kA', 'TBrk A'); await link(id.tbrkA, id.tbrk);
  id.tbrkB = await resource('ROOM', 'kB', 'TBrk B'); await link(id.tbrkB, id.tbrk);
  id.tbrkP = await resource('TEACHER', 'kP', 'Prof TBrk'); await link(id.tbrkP, id.tbrk);
  await avail(id.tbrkP, '17:00', '18:30');
  await occ(id.tbrkA, id.tbrk, '18:00', '18:30'); // A livre 17:00–18:00
  await occ(id.tbrkB, id.tbrk, '17:00', '17:30'); // B livre 17:30–18:30
  // subvãos: 17:00–17:30 {A} · 17:30–18:00 {A,B} · 18:00–18:30 {B}.
  //   [17:00–17:30]∩[17:30–18:00] = {A} → funde (17:00–18:00, [A]); ∩[18:00–18:30]{B} = ∅ → quebra.

  // ----- PROFS também: prof entra no meio → funde, profs do bloco = interseção ----------------
  // sala livre o bloco todo; prof X livre 17:00–18:00; prof Y livre só 17:30–18:00.
  id.prof = await cap('cap:prof', 'Prof');
  id.profR = await resource('ROOM', 'pR', 'Prof R'); await link(id.profR, id.prof);
  id.profX = await resource('TEACHER', 'pX', 'Prof X'); await link(id.profX, id.prof);
  id.profY = await resource('TEACHER', 'pY', 'Prof Y'); await link(id.profY, id.prof);
  await avail(id.profX, '17:00', '18:00');
  await avail(id.profY, '17:30', '18:00'); // entra às 17:30
  // subvãos: 17:00–17:30 {X} · 17:30–18:00 {X,Y}; interseção profs = {X}.

  // ----- RETROCOMPAT: vão já contínuo (sem mudança de composição) não muda --------------------
  id.cont = await cap('cap:cont', 'Cont');
  id.contR = await resource('ROOM', 'nR', 'Cont R'); await link(id.contR, id.cont);
  id.contP = await resource('TEACHER', 'nP', 'Prof Cont'); await link(id.contP, id.cont);
  await avail(id.contP, '17:00', '18:00'); // nenhuma ocupação → único subvão 17:00–18:00
});

after(async () => { await new Promise((r) => server.close(r)); await pool.end(); });

// ---------------------------------------------------------------------------
test('CANTO — funde 17:00–17:30 + 17:30–18:00 num vão 17:00–18:00; sala C (não cobre) SAI do hover', async () => {
  const { json } = await grade('cap:canto');
  assert.deepEqual(vaosWD(json), [
    { faixa: '17:00-18:00', profs: ['Prof Canto'], salas: ['Sala A', 'Sala B'] },
  ]);
  // contagem (retrocompat) = tamanho da interseção
  const v = json.vaos.find((x) => x.weekday === WD);
  assert.equal(v.profs_livres, 1);
  assert.equal(v.salas_livres, 2);
});

test('NÃO FUNDE — sem continuidade de sala (interseção vazia): 2 vãos distintos', async () => {
  const { json } = await grade('cap:desc');
  assert.deepEqual(vaosWD(json), [
    { faixa: '17:00-17:30', profs: ['Prof Desc'], salas: ['Desc A'] },
    { faixa: '17:30-18:00', profs: ['Prof Desc'], salas: ['Desc B'] },
  ]);
});

test('TRANSITIVA — 3 subvãos com T e prof comuns aos três → 1 bloco 17:00–18:30, salas=[T]', async () => {
  const { json } = await grade('cap:trans');
  assert.deepEqual(vaosWD(json), [
    { faixa: '17:00-18:30', profs: ['Prof Trans'], salas: ['Trans T'] },
  ]);
});

test('TRANSITIVA QUEBRA — A-B fundem (17:00–18:00, [A]); C separado (18:00–18:30, [B])', async () => {
  const { json } = await grade('cap:tbrk');
  assert.deepEqual(vaosWD(json), [
    { faixa: '17:00-18:00', profs: ['Prof TBrk'], salas: ['TBrk A'] },
    { faixa: '18:00-18:30', profs: ['Prof TBrk'], salas: ['TBrk B'] },
  ]);
});

test('PROFS — prof Y entra às 17:30 → funde 17:00–18:00; profs do bloco = interseção [Prof X]', async () => {
  const { json } = await grade('cap:prof');
  assert.deepEqual(vaosWD(json), [
    { faixa: '17:00-18:00', profs: ['Prof X'], salas: ['Prof R'] },
  ]);
});

test('RETROCOMPAT — vão já contínuo (sem mudança de composição) não muda', async () => {
  const { json } = await grade('cap:cont');
  assert.deepEqual(vaosWD(json), [
    { faixa: '17:00-18:00', profs: ['Prof Cont'], salas: ['Cont R'] },
  ]);
});

test('COBERTURA — vãos fundidos ∪ buracos = expediente 09:00–22:00 (sem furo nem overlap)', async () => {
  for (const cp of ['cap:canto', 'cap:desc', 'cap:trans', 'cap:tbrk', 'cap:prof', 'cap:cont']) {
    const { json } = await grade(cp);
    assert.equal(coberturaOk(json, WD, '09:00', '22:00'), true, `${cp} não cobre o expediente`);
  }
});

test('RLS — tenant B não vê a grade de A → 404', async () => {
  const res = await api(`/tenant/${TENANT_B}/resources/grade-recorrente?capability=cap:canto`);
  assert.equal(res.status, 404);
});
