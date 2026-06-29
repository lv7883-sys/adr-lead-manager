'use strict';

// Testes de INTEGRAÇÃO da DURAÇÃO da ocupação (slot_end) na captura (Frente A — passo 1).
// captureHistory passa a gravar slot_end = aula.hora_fim (o parser já fornece). Exercita com IO
// INJETADO (HTML mock — sem Extranet), contra Postgres DESCARTÁVEL (migrations 046 + 048 + 050).
// Cobre: coluna slot_end nullable, duração real gravada (banda 1h30, aula 45min, aula 1h), diff
// por mudança de DURAÇÃO, linha ROOM e TEACHER com slot_end, e a regressão (cancelada não entra).
//
// Provisão: test/run-captura-duracao-itest.sh.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { pool, withTenant } = require('../src/db');
const adapter = require('../src/resources/adapters/scrape-extranet');

const T = process.env.RESOURCES_TENANT_ID;
const q = (sql, params) => withTenant(T, (c) => c.query(sql, params)).then((r) => r.rows);

const ids = { cap: {}, room: {}, teacher: {} };

function anchor(id, hi, hf, sala, curso, status, prof) {
  const title = [`${hi} - ${hf}`, sala, `Curso ${curso}`, status].join('&#10;');
  return `<a href="#" onclick="aula_edit('${id}')" title="${title}">Prof. ${prof}</a>`;
}

// MOCK base (weekday 1): banda 1h30, aula 45min (17:30-18:15), aula 1h, e uma cancelada.
const mock = (fimBanda) => `<table><tbody>
${anchor(1, '14:00', fimBanda, 'Sala 7', 'DRUM', 'Prevista', 'Ricardo')}
${anchor(2, '17:30', '18:15', 'Sala 9', 'GUIT', 'Prevista', 'Enzo')}
${anchor(3, '10:00', '11:00', 'Sala 7', 'DRUM', 'Confirmada pelo aluno', 'Ricardo')}
${anchor(4, '09:00', '10:00', 'Sala 7', 'DRUM', 'Cancelada pelo aluno', 'Ricardo')}
</tbody></table>`;

let run1;

before(async () => {
  for (const [k, name] of [['bateria', 'Bateria'], ['canto', 'Canto'], ['guitarra', 'Guitarra']]) {
    ids.cap[k] = (await q(`INSERT INTO resources.capability (tenant_id, external_ref, name) VALUES ($1,$2,$3) RETURNING id`,
      [T, `cap:${k}`, name]))[0].id;
  }
  const room = async (ref, name) => (await q(
    `INSERT INTO resources.resource (tenant_id, type, external_ref, name) VALUES ($1,'ROOM',$2,$3) RETURNING id`,
    [T, String(ref), name]))[0].id;
  ids.room[7] = await room(7, 'Sala 7 ( Estúdio Slash )');
  ids.room[9] = await room(9, 'Sala 9 ( Estúdio Principal )');
  const teach = async (ref, name) => (await q(
    `INSERT INTO resources.resource (tenant_id, type, external_ref, name) VALUES ($1,'TEACHER',$2,$3) RETURNING id`,
    [T, ref, name]))[0].id;
  ids.teacher.ricardo = await teach('T1', 'Ricardo Souza');
  ids.teacher.enzo = await teach('T2', 'Enzo Fernandes');

  const link = (resId, capId) => q(
    `INSERT INTO resources.resource_capability (tenant_id, resource_id, capability_id) VALUES ($1,$2,$3)`, [T, resId, capId]);
  await link(ids.room[7], ids.cap.bateria);
  await link(ids.room[9], ids.cap.bateria); await link(ids.room[9], ids.cap.canto); await link(ids.room[9], ids.cap.guitarra);
  await link(ids.teacher.ricardo, ids.cap.bateria);
  await link(ids.teacher.enzo, ids.cap.guitarra);

  // RUN 1 — banda termina 15:30.
  run1 = await adapter.captureHistory({
    tenantId: T, binding: { config: {} },
    getGradeHtml: async (_d, idx) => (idx === 0 ? mock('15:30') : ''),
  });
});

after(async () => { await pool.end(); });

// estado vigente por (resource, weekday, slot) — DISTINCT ON changed_at DESC.
const vigente = (slot) => q(
  `SELECT DISTINCT ON (oh.resource_id, oh.weekday, oh.slot_time)
          r.type, r.external_ref, to_char(oh.slot_time,'HH24:MI') slot,
          to_char(oh.slot_end,'HH24:MI') slot_end, oh.occupied
     FROM resources.occupation_history oh JOIN resources.resource r ON r.id=oh.resource_id
    WHERE oh.weekday=1 AND oh.slot_time=$1::time
    ORDER BY oh.resource_id, oh.weekday, oh.slot_time, oh.changed_at DESC`, [slot]);

// ---------------------------------------------------------------------------
test('1. migration 050: coluna slot_end existe e é NULLABLE', async () => {
  const col = await q(
    `SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema='resources' AND table_name='occupation_history' AND column_name='slot_end'`);
  assert.equal(col.length, 1, 'coluna slot_end deve existir');
  assert.match(col[0].data_type, /time/);
  assert.equal(col[0].is_nullable, 'YES');
});

test('2. banda 1h30 (14:00-15:30) → slot_end 15:30 em ROOM e TEACHER', async () => {
  const rows = await vigente('14:00');
  const room = rows.find((x) => x.type === 'ROOM' && x.external_ref === '7');
  const teach = rows.find((x) => x.type === 'TEACHER' && x.external_ref === 'T1');
  assert.ok(room && teach, 'esperava linha ROOM(7) e TEACHER(T1) às 14:00');
  assert.equal(room.slot_end, '15:30');
  assert.equal(teach.slot_end, '15:30');
  assert.equal(room.occupied, true);
});

test('3. aula 45min (17:30-18:15) → slot_end 18:15 (ROOM Sala 9 + TEACHER Enzo)', async () => {
  const rows = await vigente('17:30');
  assert.ok(rows.every((x) => x.slot_end === '18:15'), 'todas as linhas 17:30 devem terminar 18:15');
  assert.ok(rows.some((x) => x.type === 'ROOM' && x.external_ref === '9'));
  assert.ok(rows.some((x) => x.type === 'TEACHER' && x.external_ref === 'T2'));
});

test('4. aula 1h (10:00-11:00) → slot_end 11:00', async () => {
  const rows = await vigente('10:00');
  const room = rows.find((x) => x.type === 'ROOM' && x.external_ref === '7');
  assert.equal(room.slot_end, '11:00');
});

test('5. regressão: cancelada (09:00) NÃO entra; stats coerentes', async () => {
  assert.deepEqual(await vigente('09:00'), []);
  assert.ok(run1.canceladas >= 1);
  assert.ok(run1.salasResolvidas >= 1 && run1.resolvidas >= 1);
});

test('6. DIFF por mudança de DURAÇÃO: rerodar com banda 14:00-15:00 grava nova linha (slot_end 15:00)', async () => {
  const antes = (await q(
    `SELECT count(*)::int n FROM resources.occupation_history oh JOIN resources.resource r ON r.id=oh.resource_id
      WHERE r.external_ref='7' AND r.type='ROOM' AND oh.weekday=1 AND oh.slot_time='14:00'::time`))[0].n;

  const run2 = await adapter.captureHistory({
    tenantId: T, binding: { config: {} },
    getGradeHtml: async (_d, idx) => (idx === 0 ? mock('15:00') : ''),
  });
  assert.ok(run2.mudancasGravadas >= 1, 'mudança de duração deve gerar ≥1 inserção');

  const depois = (await q(
    `SELECT count(*)::int n FROM resources.occupation_history oh JOIN resources.resource r ON r.id=oh.resource_id
      WHERE r.external_ref='7' AND r.type='ROOM' AND oh.weekday=1 AND oh.slot_time='14:00'::time`))[0].n;
  assert.equal(depois, antes + 1, 'a mudança de duração deve append UMA nova linha (append-only)');

  // estado vigente agora reflete a nova duração 15:00.
  const room = (await vigente('14:00')).find((x) => x.type === 'ROOM' && x.external_ref === '7');
  assert.equal(room.slot_end, '15:00');
  // e as duas durações coexistem no histórico (append-only).
  const ends = (await q(
    `SELECT DISTINCT to_char(slot_end,'HH24:MI') e FROM resources.occupation_history oh JOIN resources.resource r ON r.id=oh.resource_id
      WHERE r.external_ref='7' AND r.type='ROOM' AND oh.weekday=1 AND oh.slot_time='14:00'::time ORDER BY 1`)).map((x) => x.e);
  assert.deepEqual(ends, ['15:00', '15:30']);
});

test('7. estabilidade: rerodar IDÊNTICO não gera novas linhas (slot_end igual = sem mudança)', async () => {
  const antes = (await q(`SELECT count(*)::int n FROM resources.occupation_history`))[0].n;
  const run3 = await adapter.captureHistory({
    tenantId: T, binding: { config: {} },
    getGradeHtml: async (_d, idx) => (idx === 0 ? mock('15:00') : ''),
  });
  assert.equal(run3.mudancasGravadas, 0, 'rodada idêntica → zero mudanças');
  const depois = (await q(`SELECT count(*)::int n FROM resources.occupation_history`))[0].n;
  assert.equal(depois, antes);
});
