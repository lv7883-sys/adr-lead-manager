'use strict';
// stages.itest.js — Passo 1: régua canônica de estágios (src/stages.js). É REFACTOR: prova que a
// nova fonte única reproduz EXATAMENTE o comportamento antigo (kanbanColuna + OR-proxy do funil),
// que SQL ≡ JS (sem cópia divergente) e que loadStages cai no default sem config (multi-tenant).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const {
  stageKey, stageOfLead, isStage, stageSql, funilBucketSql, loadStages,
  KANBAN_TRANSICOES, STATUS_TO_KEY, KEY_TO_STATUS, PERDIDO_DESFECHOS,
} = require('../src/stages');

// ---- referência ANTIGA (copiada dos originais, ANTES do refactor) — o alvo a igualar -----------
function kanbanColunaOLD(status, desfecho) {
  const P = ['nao_matriculado_preco', 'nao_matriculado_horario', 'nao_matriculado_concorrente',
    'nao_matriculado_desistiu', 'nao_compareceu_aula', 'outro'];
  if (P.includes(desfecho)) return 'perdido';
  if (desfecho === 'matriculado' || status === 'CONVERTED') return 'convertido';
  if (status === 'NEW') return 'novo';
  if (status === 'EXPERIMENTAL_AGENDADA') return 'experimental';
  if (status === 'QUALIFIED') return 'qualificado';
  return 'qualificando';
}
// funil OR-proxy ANTIGO (metrics.js, inline) — as três FILTER expressions, byte-a-byte.
const OLD_AGENDADA = "intent = 'SCHEDULE_INTEREST' OR status = 'EXPERIMENTAL_AGENDADA' OR desfecho = 'nao_compareceu_aula'";
const OLD_REALIZADA = `(${OLD_AGENDADA}) AND desfecho IS NOT NULL AND desfecho <> 'nao_compareceu_aula'`;
const OLD_MATRICULA = "desfecho = 'matriculado'";

const STATUSES = ['NEW', 'QUALIFYING', 'QUALIFIED', 'EXPERIMENTAL_AGENDADA', 'CONVERTED', 'PERDIDO', 'NOT_LEAD', 'REVIEW_QUEUE', null];
const DESFECHOS = [null, 'matriculado', 'nao_compareceu_aula', 'nao_matriculado_preco', 'nao_matriculado_horario',
  'nao_matriculado_concorrente', 'nao_matriculado_desistiu', 'outro', 'nao_e_lead', 'xpto'];
const INTENTS = [null, 'SCHEDULE_INTEREST', 'GENERAL_INFO'];

let c;
const T1 = '00000000-0000-0000-0000-0000000000a1';
const T2 = '00000000-0000-0000-0000-0000000000a2';
// withTenant injetável p/ loadStages: filtra por tenant no client efêmero (sem RLS).
const fakeWithTenant = (tid, fn) => fn({
  query: (sql, params) => c.query(sql.replace('tenant_id = $1', 'tenant_id = $1'), params),
});

before(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  await c.query(`
    CREATE TABLE leads (id serial PRIMARY KEY, tenant_id uuid, status text, desfecho text, intent text);
    CREATE TABLE tenant_lead_config (tenant_id uuid PRIMARY KEY, stage_definitions jsonb);`);
  // todas as combinações status×desfecho×intent → cobertura total da partição e do funil.
  for (const s of STATUSES) for (const d of DESFECHOS) for (const i of INTENTS) {
    await c.query('INSERT INTO leads (tenant_id, status, desfecho, intent) VALUES ($1,$2,$3,$4)', [T1, s, d, i]);
  }
  // config só do T1 (T2 fica SEM linha → default puro).
  await c.query(`INSERT INTO tenant_lead_config (tenant_id, stage_definitions)
    VALUES ($1, $2::jsonb)`, [T1, JSON.stringify({ experimental: 'DEF experimental do tenant', qualificado: 'DEF qualificado' })]);
});
after(async () => { await c.end(); });

test('(1) stageKey/stageOfLead == kanbanColuna ANTIGO em TODAS as combinações', () => {
  let n = 0;
  for (const s of STATUSES) for (const d of DESFECHOS) {
    assert.equal(stageKey(s, d), kanbanColunaOLD(s, d), `stageKey(${s},${d})`);
    assert.equal(stageOfLead({ status: s, desfecho: d }), kanbanColunaOLD(s, d), `stageOfLead(${s},${d})`);
    n++;
  }
  assert.ok(n === STATUSES.length * DESFECHOS.length);
});

test('(2) stageSql ≡ stageOfLead (SQL == JS) linha a linha na base', async () => {
  const rows = (await c.query(`SELECT id, status, desfecho, ${stageSql('l')} AS sql_stage FROM leads l`)).rows;
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.equal(r.sql_stage, stageOfLead(r), `SQL≡JS falhou p/ status=${r.status} desfecho=${r.desfecho}`);
  }
});

test('(3) funilBucketSql reproduz o OR-proxy ANTIGO (contagens idênticas)', async () => {
  const cnt = async (frag) => (await c.query(`SELECT count(*)::int n FROM leads WHERE ${frag}`)).rows[0].n;
  assert.equal(await cnt(funilBucketSql('experimental')), await cnt(OLD_AGENDADA), 'agendadas');
  assert.equal(await cnt(funilBucketSql('realizada')), await cnt(OLD_REALIZADA), 'realizadas');
  assert.equal(await cnt(funilBucketSql('convertido')), await cnt(OLD_MATRICULA), 'matriculas');
  // sanidade: as contagens não são todas zero nem todas iguais (o teste tem sinal).
  const a = await cnt(funilBucketSql('experimental'));
  assert.ok(a > 0, 'agendadas > 0 (senão o teste é vazio)');
});

test('(4) isStage + de-para status↔coluna estáveis', () => {
  assert.equal(isStage({ status: 'EXPERIMENTAL_AGENDADA', desfecho: null }, 'experimental'), true);
  assert.equal(isStage({ status: 'QUALIFYING', desfecho: 'matriculado' }, 'convertido'), true, 'desfecho vence status');
  assert.deepEqual(STATUS_TO_KEY, { QUALIFYING: 'qualificando', QUALIFIED: 'qualificado', EXPERIMENTAL_AGENDADA: 'experimental', CONVERTED: 'convertido', PERDIDO: 'perdido' });
  assert.equal(KEY_TO_STATUS.experimental, 'EXPERIMENTAL_AGENDADA');
  // 'novo' NÃO é destino de arraste (fora do de-para), como no _KANBAN_DEST_COL antigo.
  assert.ok(!('novo' in KEY_TO_STATUS));
  // transições: full-mesh nas etapas de trabalho; 'novo' só origem.
  assert.deepEqual(KANBAN_TRANSICOES.experimental, ['qualificando', 'qualificado', 'convertido', 'perdido']);
  assert.ok(!KANBAN_TRANSICOES.qualificando.includes('novo'), 'novo nunca é destino');
});

test('(5) loadStages: default sem config; funde defs do tenant; multi-tenant isolado', async () => {
  const t1 = await loadStages(T1, { withTenant: fakeWithTenant });
  const t2 = await loadStages(T2, { withTenant: fakeWithTenant });
  const byKey = (arr) => Object.fromEntries(arr.map((s) => [s.key, s]));
  const a = byKey(t1), b = byKey(t2);
  // T1 tem defs → merge; T2 sem linha → default puro (todas definition=null).
  assert.equal(a.experimental.definition, 'DEF experimental do tenant');
  assert.equal(a.qualificado.definition, 'DEF qualificado');
  assert.equal(a.novo.definition, null, 'chave sem def no tenant fica null');
  for (const s of t2) assert.equal(s.definition, null, `T2 default: ${s.key} sem def`);
  // isolamento: a régua (keys/ordem/status) é a mesma; só as descrições variam por tenant.
  assert.deepEqual(t1.map((s) => s.key), t2.map((s) => s.key));
  // multi-tenant sem vazamento: T2 não herda as defs do T1.
  assert.notEqual(b.experimental.definition, 'DEF experimental do tenant');
});

test('(6) loadStages sem tabela/erro → default puro (degrada elegante)', async () => {
  const boom = () => { throw new Error('sem config'); };
  const out = await loadStages(T1, { withTenant: boom });
  assert.equal(out.length, 7, 'régua completa (inclui realizada funil-only)');
  for (const s of out) assert.equal(s.definition, null);
  assert.deepEqual(PERDIDO_DESFECHOS.includes('nao_compareceu_aula'), true);
});
