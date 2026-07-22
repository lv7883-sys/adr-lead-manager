'use strict';
// field-provenance.itest.js — ADR-037 emenda 2026-07-22 (proveniência humano vs scraping).
// Prova ISOLADA (PG descartável) das 3 funções + 2 tabelas. Sem HTTP, sem endpoint: chama as
// funções direto sob withTenant (SET app.current_tenant → RLS FORCE ativa). NUNCA toca produção.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, withTenant } = require('../src/db');

const A = process.env.RESOURCES_TENANT_A;   // tenant A
const B = process.env.RESOURCES_TENANT_B;   // tenant B

// helpers: 1 chamada por função, sob o tenant dado
const marcar   = (t, ek, id, f, v, actor) => withTenant(t, (c) => c.query('SELECT lead_manager.marcar_edicao_humana($1,$2,$3,$4,$5)', [ek, id, f, v, actor]));
const aplicar  = (t, ek, id, f, v, src)   => withTenant(t, async (c) => (await c.query('SELECT lead_manager.aplicar_scraping($1,$2,$3,$4,$5) AS v', [ek, id, f, v, src])).rows[0].v);
const dispensar= (t, ek, id, f)           => withTenant(t, (c) => c.query('SELECT lead_manager.dispensar_alerta($1,$2,$3)', [ek, id, f]));
// estado do alerta: { existe, ativo } (ativo = dismissed_value distinto do source_value)
const alerta   = (t, ek, id, f) => withTenant(t, async (c) => {
  const r = (await c.query(
    `SELECT human_value, source_value, dismissed_value,
            (dismissed_value IS DISTINCT FROM source_value) AS ativo
       FROM lead_manager.field_divergence
      WHERE entity_kind=$1 AND entity_id=$2 AND field=$3`, [ek, id, f])).rows[0];
  return r ? { existe: true, ativo: r.ativo, human: r.human_value, source: r.source_value } : { existe: false, ativo: false };
});
const travado  = (t, ek, id, f) => withTenant(t, async (c) => (await c.query(
  `SELECT human_value FROM lead_manager.field_provenance WHERE entity_kind=$1 AND entity_id=$2 AND field=$3`, [ek, id, f])).rows[0] || null);
// cria uma pessoa (entidade concreta p/ provar o caminho de escrita quando 'ESCREVE')
const novaPessoa = (t, nome) => withTenant(t, async (c) => (await c.query(
  `INSERT INTO lead_manager.person (tenant_id, display_name) VALUES ($1,$2) RETURNING id`, [t, nome])).rows[0].id);
const nomeDe = (t, id) => withTenant(t, async (c) => (await c.query(
  `SELECT display_name FROM lead_manager.person WHERE id=$1`, [id])).rows[0].display_name);

before(async () => { /* migrations aplicadas pelo runner */ });
after(async () => { await pool.end(); });

test('(a) humano edita → protegido; scraping divergente → NÃO sobrescreve + alerta ATIVO', async () => {
  const pid = await novaPessoa(A, 'João Humano');
  await marcar(A, 'person', pid, 'display_name', 'João Humano', 'recep1');
  const lock = await travado(A, 'person', pid, 'display_name');
  assert.equal(lock.human_value, 'João Humano', 'campo deve ficar travado com o valor humano');

  const v = await aplicar(A, 'person', pid, 'display_name', 'João Scraping', 'extranet');
  assert.equal(v, 'DIVERGE', 'scraping divergente em campo travado → DIVERGE');
  // o chamador respeita DIVERGE e NÃO escreve → base intacta
  assert.equal(await nomeDe(A, pid), 'João Humano', 'base não pode ser sobrescrita');
  const al = await alerta(A, 'person', pid, 'display_name');
  assert.deepEqual({ existe: al.existe, ativo: al.ativo, human: al.human, source: al.source },
    { existe: true, ativo: true, human: 'João Humano', source: 'João Scraping' });
});

test('(b) dispensar → silencia AQUELE valor; mesmo scraping segue silencioso', async () => {
  const pid = await novaPessoa(A, 'Maria');
  await marcar(A, 'person', pid, 'display_name', 'Maria Humano', 'recep1');
  await aplicar(A, 'person', pid, 'display_name', 'Maria Scrap', 'extranet');
  assert.equal((await alerta(A, 'person', pid, 'display_name')).ativo, true);

  await dispensar(A, 'person', pid, 'display_name');
  assert.equal((await alerta(A, 'person', pid, 'display_name')).ativo, false, 'dispensado → não-ativo');
  // novo scraping com o MESMO valor → continua silencioso
  assert.equal(await aplicar(A, 'person', pid, 'display_name', 'Maria Scrap', 'extranet'), 'DIVERGE');
  assert.equal((await alerta(A, 'person', pid, 'display_name')).ativo, false, 'mesmo valor dispensado segue silencioso');
});

test('(c) scraping com valor divergente DIFERENTE → alerta RESSURGE', async () => {
  const pid = await novaPessoa(A, 'Pedro');
  await marcar(A, 'person', pid, 'display_name', 'Pedro Humano', 'recep1');
  await aplicar(A, 'person', pid, 'display_name', 'Pedro Scrap1', 'extranet');
  await dispensar(A, 'person', pid, 'display_name');
  assert.equal((await alerta(A, 'person', pid, 'display_name')).ativo, false);

  const v = await aplicar(A, 'person', pid, 'display_name', 'Pedro Scrap2', 'extranet');  // valor NOVO
  assert.equal(v, 'DIVERGE');
  const al = await alerta(A, 'person', pid, 'display_name');
  assert.equal(al.ativo, true, 'valor divergente diferente do dispensado → RESSURGE');
  assert.equal(al.source, 'Pedro Scrap2');
});

test('(d) scraping CONVERGE (valor == humano) → alerta some sozinho', async () => {
  const pid = await novaPessoa(A, 'Ana');
  await marcar(A, 'person', pid, 'display_name', 'Ana Humano', 'recep1');
  await aplicar(A, 'person', pid, 'display_name', 'Ana Scrap', 'extranet');
  assert.equal((await alerta(A, 'person', pid, 'display_name')).existe, true);

  const v = await aplicar(A, 'person', pid, 'display_name', 'Ana Humano', 'extranet');  // fonte corrigiu
  assert.equal(v, 'IGUAL');
  assert.equal((await alerta(A, 'person', pid, 'display_name')).existe, false, 'convergiu → alerta deletado');
});

test('(e) campo NÃO protegido → scraping ESCREVE (e não cria alerta); granularidade por campo', async () => {
  const pid = await novaPessoa(A, 'Bia');
  // trava SÓ display_name; data_nascimento fica livre
  await marcar(A, 'person', pid, 'display_name', 'Bia Humano', 'recep1');
  const vLivre = await aplicar(A, 'person', pid, 'data_nascimento', '2010-05-01', 'extranet');
  assert.equal(vLivre, 'ESCREVE', 'campo livre → ESCREVE');
  // o chamador escreve de fato quando ESCREVE
  await withTenant(A, (c) => c.query(`UPDATE lead_manager.person SET data_nascimento=$2::date WHERE id=$1`, [pid, '2010-05-01']));
  assert.equal((await alerta(A, 'person', pid, 'data_nascimento')).existe, false, 'campo livre não gera alerta');
  // no MESMO registro, o campo travado ainda protege (granular)
  assert.equal(await aplicar(A, 'person', pid, 'display_name', 'Bia Scrap', 'extranet'), 'DIVERGE');
});

test('(f) CROSS-TENANT = 0: trava/alerta de A são invisíveis a B; B escreve livre', async () => {
  const pid = await novaPessoa(A, 'Carlos');
  await marcar(A, 'person', pid, 'display_name', 'Carlos Humano', 'recep1');
  await aplicar(A, 'person', pid, 'display_name', 'Carlos Scrap', 'extranet');
  // B: mesma entity_id/field — mas RLS escopa a proveniência a B (que não tem trava) → ESCREVE
  const vB = await aplicar(B, 'person', pid, 'display_name', 'Carlos Scrap', 'extranet');
  assert.equal(vB, 'ESCREVE', 'B não enxerga a trava de A → campo é livre p/ B');
  // B não vê a trava nem o alerta de A
  assert.equal(await travado(B, 'person', pid, 'display_name'), null, 'B não vê a trava de A');
  assert.equal((await alerta(B, 'person', pid, 'display_name')).existe, false, 'B não vê o alerta de A');
  // e a trava/alerta de A seguem intactos
  assert.notEqual(await travado(A, 'person', pid, 'display_name'), null);
  assert.equal((await alerta(A, 'person', pid, 'display_name')).ativo, true);
});
