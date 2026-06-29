'use strict';

// Testes de INTEGRAÇÃO da CAPTURA DE OCUPAÇÃO DE SALA + leitura de STATUS (occupation_history).
// Exercita scrape-extranet.captureHistory com IO INJETADO (HTML mock — sem Extranet), contra um
// Postgres DESCARTÁVEL (migrations 046 + 048). Cobre: mapa DP-C (statusOcupa), linha de SALA por
// VOCAÇÃO (Opção D), cancelamento que não ocupa, match de sala por external_ref, e a regressão da
// linha do PROFESSOR. NUNCA toca produção nem a Extranet.
//
// Provisão: test/run-captura-sala-itest.sh.
// weekday: a captura varre 1..6; o mock só responde o 1º fetch (idx 0 → weekday 1), '' nos demais.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { pool, withTenant } = require('../src/db');
const valinhos = require('../src/resources/adapters/valinhos');
const adapter = require('../src/resources/adapters/scrape-extranet');

const T = process.env.RESOURCES_TENANT_ID;
const q = (sql, params) => withTenant(T, (c) => c.query(sql, params)).then((r) => r.rows);

const ids = { cap: {}, room: {}, teacher: {} };

// monta uma âncora aula_edit no formato que parseGradeOcupacao espera (title com &#10; = quebras).
function anchor(id, hi, hf, sala, curso, status, prof) {
  const title = [`${hi} - ${hf}`, sala, `Curso ${curso}`, status].join('&#10;');
  return `<a href="#" onclick="aula_edit('${id}')" title="${title}">Prof. ${prof}</a>`;
}

// HTML mock = grade do weekday 1 (6 aulas, salas 7/9/4/5/99).
const MOCK_HTML = `<table><tbody>
${anchor(1, '15:00', '16:00', 'Sala 7', 'DRUM', 'Prevista', 'Ricardo')}
${anchor(2, '16:00', '17:00', 'Sala 9', 'VOCAL', 'Confirmada pelo aluno', 'Isabella')}
${anchor(3, '10:00', '11:00', 'Sala 4', 'GUIT', 'Cancelada pelo aluno', 'Ricardo')}
${anchor(4, '11:00', '12:00', 'Sala 5', 'PIA', 'Prevista', 'Zzz')}
${anchor(5, '09:00', '10:00', 'Sala 99', 'DRUM', 'Prevista', 'Yyy')}
${anchor(6, '17:00', '18:00', 'Sala 7', 'VOCAL', 'Prevista', 'Www')}
</tbody></table>`;

let captured;

before(async () => {
  // capabilities
  for (const [k, name] of [['bateria', 'Bateria'], ['canto', 'Canto'], ['guitarra', 'Guitarra'],
    ['baixo', 'Baixo'], ['violao', 'Violão'], ['ukulele', 'Ukulele'], ['piano', 'Piano']]) {
    ids.cap[k] = (await q(
      `INSERT INTO resources.capability (tenant_id, external_ref, name) VALUES ($1,$2,$3) RETURNING id`,
      [T, `cap:${k}`, name]))[0].id;
  }
  // salas (ROOM) por external_ref numérico
  const room = async (ref, name) => (await q(
    `INSERT INTO resources.resource (tenant_id, type, external_ref, name) VALUES ($1,'ROOM',$2,$3) RETURNING id`,
    [T, String(ref), name]))[0].id;
  ids.room[7] = await room(7, 'Sala 7 ( Estúdio Slash )');
  ids.room[9] = await room(9, 'Sala 9 ( Estúdio Principal )');
  ids.room[4] = await room(4, 'Sala 4 ( Cordas )');
  ids.room[5] = await room(5, 'Sala 5 ( sem vocação )');
  // professor
  ids.teacher.ricardo = (await q(
    `INSERT INTO resources.resource (tenant_id, type, external_ref, name) VALUES ($1,'TEACHER','T1',$2) RETURNING id`,
    [T, 'Ricardo Souza']))[0].id;

  // vínculos (vocações da sala / competências do prof)
  const link = (resId, capId) => q(
    `INSERT INTO resources.resource_capability (tenant_id, resource_id, capability_id) VALUES ($1,$2,$3)`, [T, resId, capId]);
  await link(ids.room[7], ids.cap.bateria);                                   // Sala 7 → bateria
  await link(ids.room[9], ids.cap.bateria); await link(ids.room[9], ids.cap.canto); await link(ids.room[9], ids.cap.guitarra); // Sala 9 → 3
  await link(ids.room[4], ids.cap.guitarra); await link(ids.room[4], ids.cap.baixo); await link(ids.room[4], ids.cap.violao); await link(ids.room[4], ids.cap.ukulele); // Sala 4 → 4
  // Sala 5: NENHUMA vocação (de propósito)
  await link(ids.teacher.ricardo, ids.cap.bateria);                           // Ricardo → bateria

  // roda a captura com IO injetado: mock só no 1º fetch (weekday 1), vazio nos demais.
  captured = await adapter.captureHistory({
    tenantId: T,
    binding: { config: {} },
    getGradeHtml: async (_date, idx) => (idx === 0 ? MOCK_HTML : ''),
  });
});

after(async () => { await pool.end(); });

// helper: linhas de occupation_history por slot (weekday 1), com ref legível.
const occAt = async (slot) => q(
  `SELECT oh.resource_id, r.type, r.external_ref, cap.external_ref AS cap_ref, oh.occupied
     FROM resources.occupation_history oh
     JOIN resources.resource r ON r.id = oh.resource_id
     JOIN resources.capability cap ON cap.id = oh.capability_id
    WHERE oh.weekday=1 AND oh.slot_time=$1::time
    ORDER BY r.type, cap.external_ref`, [slot]);

// ---------------------------------------------------------------------------
test('1. statusOcupa (DP-C, puro): firmes→true, Cancelada*→false, desconhecido/vazio→true', () => {
  for (const s of ['Prevista', 'Confirmada pelo aluno', 'Confirmada', 'Realizada', 'Falta do aluno', 'Falta']) {
    assert.equal(valinhos.statusOcupa(s), true, `${s} deveria ocupar`);
  }
  for (const s of ['Cancelada pelo aluno', 'Cancelada pelo professor', 'Cancelada período de ausência', 'CANCELADA']) {
    assert.equal(valinhos.statusOcupa(s), false, `${s} NÃO deveria ocupar`);
  }
  assert.equal(valinhos.statusOcupa('Status Estranho'), true); // desconhecido → conservador
  assert.equal(valinhos.statusOcupa(''), true);
  assert.equal(valinhos.statusConhecido('Status Estranho'), false);
  assert.equal(valinhos.statusConhecido('Prevista'), true);
});

test('2. Sala 7 ocupada 15h → 1 linha ROOM (bateria) + regressão: a linha do PROFESSOR também', async () => {
  const rows = await occAt('15:00');
  const room = rows.filter((x) => x.type === 'ROOM');
  const teach = rows.filter((x) => x.type === 'TEACHER');
  assert.deepEqual(room.map((x) => `${x.external_ref}:${x.cap_ref}`), ['7:cap:bateria']);
  assert.equal(room[0].occupied, true);
  // REGRESSÃO: professor Ricardo (bateria) continua gravado.
  assert.equal(teach.length, 1);
  assert.equal(teach[0].resource_id, ids.teacher.ricardo);
  assert.equal(teach[0].cap_ref, 'cap:bateria');
});

test('3. Sala 9 ocupada 16h → 3 linhas ROOM (bateria,canto,guitarra), sem professor (Isabella ambígua)', async () => {
  const rows = await occAt('16:00');
  const room = rows.filter((x) => x.type === 'ROOM');
  const teach = rows.filter((x) => x.type === 'TEACHER');
  assert.equal(teach.length, 0, 'Isabella não está no catálogo → nenhuma linha de professor');
  assert.deepEqual(room.map((x) => x.cap_ref).sort(), ['cap:bateria', 'cap:canto', 'cap:guitarra']);
  assert.ok(room.every((x) => x.external_ref === '9' && x.occupied === true));
});

test('4. Sala 4 "Cancelada pelo aluno" 10h → NENHUMA linha (nem ROOM nem professor)', async () => {
  assert.deepEqual(await occAt('10:00'), []);
});

test('5. match de sala: "Sala 99" (inexistente) 09h → pulada (log), sem linha e sem crash', async () => {
  assert.deepEqual(await occAt('09:00'), []);
  assert.ok(captured.salasNaoCasadas >= 1, 'deveria contar 1 sala não casada (Sala 99)');
});

test('6. Sala 5 sem vocação 11h (prof ambíguo) → pulada, NENHUMA linha', async () => {
  assert.deepEqual(await occAt('11:00'), []);
  assert.ok(captured.salasSemVocacao >= 1, 'deveria contar 1 sala sem vocação (Sala 5)');
});

test('7. validação informativa: Sala 7 com Curso VOCAL 17h → linha ROOM (bateria) gravada + inconsistência logada', async () => {
  const rows = await occAt('17:00');
  assert.deepEqual(rows.map((x) => `${x.type}:${x.external_ref}:${x.cap_ref}`), ['ROOM:7:cap:bateria']);
  assert.ok(captured.vocacaoInconsistente >= 1, 'curso VOCAL ∉ vocação(bateria) da Sala 7 → inconsistência');
});

test('8. stats agregados da rodada conferem (6 fetches, cancelada contada, salas resolvidas)', async () => {
  assert.equal(captured.fetched, 6);
  assert.ok(captured.canceladas >= 1);
  assert.equal(captured.salasResolvidas, 3, 'Sala 7(15h) + Sala 9(16h) + Sala 7(17h)');
  assert.equal(captured.resolvidas, 1, 'só Ricardo(15h) resolve — o de 10h é cancelado antes do prof');
  // total de linhas no histórico = 2 (15h) + 3 (16h) + 1 (17h) = 6, todas occupied=true.
  const tot = (await q(`SELECT count(*)::int n, count(*) FILTER (WHERE occupied)::int oc FROM resources.occupation_history`))[0];
  assert.equal(tot.n, 6);
  assert.equal(tot.oc, 6);
});
