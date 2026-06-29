'use strict';

// Testes de INTEGRAÇÃO da CAPTURA DE 4 SEMANAS — destilação do recorrente "OCUPADO GANHA".
// captureHistory lê 4 ocorrências de cada weekday e destila: ocupado no recorrente se houve aula
// em >=1 das 4 semanas; livre só se livre nas 4. Uma anomalia isolada (cancelamento/feriado numa
// semana) NÃO apaga a ocupação. IO injetado (HTML mock por weekday×semana) — sem Extranet.
// Postgres DESCARTÁVEL (046+048+050). Provisão: test/run-captura-4-semanas-itest.sh.
//
// idx do getGradeHtml é wd-major: weekday = floor(idx/4)+1, semana = idx%4 (SEMANAS=4 default).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { pool, withTenant } = require('../src/db');
const adapter = require('../src/resources/adapters/scrape-extranet');

const T = process.env.RESOURCES_TENANT_ID;
const SEMANAS = 4;
const q = (sql, params) => withTenant(T, (c) => c.query(sql, params)).then((r) => r.rows);
const ids = {};

function anchor(id, hi, hf, sala, curso, status, prof) {
  const title = [`${hi} - ${hf}`, sala, `Curso ${curso}`, status].join('&#10;');
  return `<a onclick="aula_edit('${id}')" title="${title}">Prof. ${prof}</a>`;
}
const htmlDe = (aulas) => `<table><tbody>${aulas.map((a, i) => anchor(i + 1, a.hi, a.hf, a.sala, a.curso, a.status, a.prof)).join('\n')}</tbody></table>`;

// CENÁRIO por (weekday, semana) → aulas na Sala 7 (bateria), prof Ricardo.
const A = (hf = '15:00', status = 'Prevista') => [{ hi: '14:00', hf, sala: 'Sala 7', curso: 'DRUM', status, prof: 'Ricardo' }];
function aulasFor(wd, week) {
  switch (wd) {
    case 1: return A();                                              // 4/4 ocupado
    case 2: return week === 1 ? A('15:00', 'Cancelada pelo aluno') : A(); // 3/4 ocupado + 1 cancelada (CASO LEO)
    case 3: return [];                                               // 0/4 livre
    case 4: return week === 2 ? A() : [];                            // 1/4 ocupado (ocupado ganha)
    case 5: return week === 0 ? [] : (week <= 2 ? A('15:30') : A('15:00')); // feriado(sem0) + duração 15:30/15:00
    case 6: return A();                                             // ocupado (usado no teste de falha de 1 semana)
    default: return [];
  }
}
// getGradeHtml canônico: decodifica idx → (wd, semana). Lança em (wd6, semana1) p/ testar falha.
const canonico = async (_date, idx) => {
  const wd = Math.floor(idx / SEMANAS) + 1;
  const week = idx % SEMANAS;
  if (wd === 6 && week === 1) throw new Error('timeout simulado (semana 2 da wd6)');
  return htmlDe(aulasFor(wd, week));
};

const vigente = (resId, wd, slot) => q(
  `SELECT DISTINCT ON (oh.resource_id, oh.weekday, oh.slot_time)
          to_char(oh.slot_end,'HH24:MI') AS slot_end, oh.occupied
     FROM resources.occupation_history oh
    WHERE oh.resource_id=$1 AND oh.weekday=$2 AND oh.slot_time=$3::time
    ORDER BY oh.resource_id, oh.weekday, oh.slot_time, oh.changed_at DESC`, [resId, wd, slot]);

let run1;
before(async () => {
  ids.bateria = (await q(`INSERT INTO resources.capability (tenant_id, external_ref, name) VALUES ($1,'cap:bateria','Bateria') RETURNING id`, [T]))[0].id;
  ids.r7 = (await q(`INSERT INTO resources.resource (tenant_id, type, external_ref, name) VALUES ($1,'ROOM','7','Sala 7') RETURNING id`, [T]))[0].id;
  ids.pa = (await q(`INSERT INTO resources.resource (tenant_id, type, external_ref, name) VALUES ($1,'TEACHER','T1','Ricardo Souza') RETURNING id`, [T]))[0].id;
  await q(`INSERT INTO resources.resource_capability (tenant_id, resource_id, capability_id) VALUES ($1,$2,$3),($1,$4,$3)`, [T, ids.r7, ids.bateria, ids.pa]);

  run1 = await adapter.captureHistory({ tenantId: T, binding: { config: {} }, getGradeHtml: canonico });
});
after(async () => { await pool.end(); });

// ---------------------------------------------------------------------------
test('1. ocupado em 4/4 semanas → recorrente OCUPADO', async () => {
  const v = await vigente(ids.r7, 1, '14:00');
  assert.equal(v.length, 1); assert.equal(v[0].occupied, true);
});

test('2. CASO LEO: ocupado 3/4 + cancelado em 1 semana → recorrente OCUPADO (cancelamento não apaga)', async () => {
  const v = await vigente(ids.r7, 2, '14:00');
  assert.equal(v.length, 1); assert.equal(v[0].occupied, true);
});

test('3. livre em 4/4 semanas → recorrente LIVRE (nenhuma linha)', async () => {
  assert.deepEqual(await vigente(ids.r7, 3, '14:00'), []);
});

test('4. ocupado só em 1/4 → recorrente OCUPADO (ocupado ganha)', async () => {
  const v = await vigente(ids.r7, 4, '14:00');
  assert.equal(v.length, 1); assert.equal(v[0].occupied, true);
});

test('5. FERIADO (1 semana vazia) entre 3 com aula → recorrente OCUPADO (feriado neutralizado)', async () => {
  const v = await vigente(ids.r7, 5, '14:00');
  assert.equal(v.length, 1); assert.equal(v[0].occupied, true);
});

test('6. DURAÇÃO: 14:00-15:30 em 2 semanas e 14:00-15:00 em outras → slot_end = 15:30 (o MAIOR)', async () => {
  const v = await vigente(ids.r7, 5, '14:00');
  assert.equal(v[0].slot_end, '15:30');
});

test('7. FALHA de 1 semana (wd6 semana 2 lançou erro) → decide com as 3 → OCUPADO (não assume livre)', async () => {
  const v = await vigente(ids.r7, 6, '14:00');
  assert.equal(v.length, 1); assert.equal(v[0].occupied, true);
  assert.ok(run1.semanasFalhadas >= 1, 'deve contar a semana que falhou');
  assert.equal(run1.weekdaysSemDado, 0, 'nenhum weekday ficou totalmente sem dado');
  assert.equal(run1.fetched, 23, '24 tentativas − 1 falha = 23 fetches ok');
});

test('8. IDEMPOTENTE: rerodar com o MESMO mock → 0 mudanças (estado destilado igual ao vigente)', async () => {
  const run2 = await adapter.captureHistory({ tenantId: T, binding: { config: {} }, getGradeHtml: canonico });
  assert.equal(run2.mudancasGravadas, 0);
});

test('9. TODAS as 4 semanas de um weekday falham → PRESERVA o estado (não libera por falha)', async () => {
  const antes = (await q(`SELECT count(*)::int n FROM resources.occupation_history`))[0].n;
  // mock que lança para TODA a wd1 (idx 0..3); demais weekdays normais (sem o throw da wd6).
  const falhaWd1 = async (_date, idx) => {
    const wd = Math.floor(idx / SEMANAS) + 1;
    const week = idx % SEMANAS;
    if (wd === 1) throw new Error('timeout simulado (todas as semanas da wd1)');
    return htmlDe(aulasFor(wd, week));
  };
  const run3 = await adapter.captureHistory({ tenantId: T, binding: { config: {} }, getGradeHtml: falhaWd1 });
  assert.ok(run3.weekdaysSemDado >= 1, 'wd1 deve contar como weekday sem dado');
  // wd1 14:00 CONTINUA ocupado (não virou false por falha).
  const v = await vigente(ids.r7, 1, '14:00');
  assert.equal(v.length, 1); assert.equal(v[0].occupied, true);
  // nenhuma linha occupied=false foi inserida para wd1 (preservação).
  const falsas = (await q(
    `SELECT count(*)::int n FROM resources.occupation_history WHERE resource_id=$1 AND weekday=1 AND occupied=false`, [ids.r7]))[0].n;
  assert.equal(falsas, 0, 'preservação: nenhuma liberação por falha');
  // total de linhas não cresceu por causa da wd1 (só, no máximo, recapturas idênticas = 0).
  const depois = (await q(`SELECT count(*)::int n FROM resources.occupation_history`))[0].n;
  assert.equal(depois, antes, 'falha total de weekday não grava nada');
});
