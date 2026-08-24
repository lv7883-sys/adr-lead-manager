'use strict';
// sync-professores.itest.js — GARANTIA do professor canônico (person + external_ref('professor'))
// a partir dos contratos, fechando service_account.professor_person_id. Prova ISOLADA (PG
// descartável) do syncProfessores com dados SINTÉTICOS. NUNCA toca produção.
//
// Provisão: test/run-sync-professores-itest.sh (sobe PG, migrations 060/105 + 046 resources, envs).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, withTenant } = require('../src/db');
const { syncProfessores, slugNome } = require('../src/cadastro/sync-professores');

const A = process.env.RESOURCES_TENANT_A;
const B = process.env.RESOURCES_TENANT_B;

// --- helpers de escrita ---
const seedContrato = (t, professorNome, professorPersonId = null) => withTenant(t, async (c) => (await c.query(
  `INSERT INTO lead_manager.service_account (tenant_id, status, professor_nome, professor_person_id)
   VALUES ($1,'ativo',$2,$3) RETURNING id`, [t, professorNome, professorPersonId])).rows[0].id);
const seedTeacher = (t, extId, nome) => withTenant(t, (c) => c.query(
  `INSERT INTO resources.resource (tenant_id, type, name, external_ref, active) VALUES ($1,'TEACHER',$2,$3,true)`,
  [t, nome, extId]));
const run = (t) => withTenant(t, (c) => syncProfessores(c, { tenantId: t }));

// --- helpers de leitura (tenant-scoped) ---
const ppid = (t, saId) => withTenant(t, async (c) => (await c.query(
  `SELECT professor_person_id::text AS id FROM lead_manager.service_account WHERE id=$1`, [saId])).rows[0].id);
const refByExtId = (t, extId) => withTenant(t, async (c) => (await c.query(
  `SELECT er.entity_id::text AS person_id, p.display_name
     FROM lead_manager.external_ref er JOIN lead_manager.person p ON p.id=er.entity_id
    WHERE er.entity_kind='person' AND er.external_type='professor' AND er.external_id=$1`, [extId])).rows[0] || null);
const countProfPersons = (t, nome) => withTenant(t, async (c) => (await c.query(
  `SELECT count(*)::int AS n FROM lead_manager.person p
     JOIN lead_manager.external_ref er ON er.entity_id=p.id AND er.external_type='professor'
    WHERE p.tenant_id=$1 AND p.display_name=$2`, [t, nome])).rows[0].n);

before(async () => {}); after(async () => { await pool.end(); });

test('(a) professor que casa com TEACHER → external_ref pela ID da Extranet + fecha professor_person_id', async () => {
  await seedTeacher(A, '777', 'Rafael Leandro Gouveia do Carmo');
  const sa = await seedContrato(A, 'Rafael Leandro Gouveia do Carmo');
  const st = await run(A);
  assert.equal(st.por_id, 1, 'resolveu pelo id da Extranet');
  const ref = await refByExtId(A, '777');                          // chaveado pelo id do cadastro
  assert.notEqual(ref, null);
  assert.equal(ref.display_name, 'Rafael Leandro Gouveia do Carmo'); // invariante: display_name == professor_nome
  assert.equal(await ppid(A, sa), ref.person_id, 'contrato fechado com a mesma pessoa');
  assert.equal(st.contratos_fechados, 1);
});

test('(b) professor SEM TEACHER → external_ref por slug do nome + fecha assim mesmo', async () => {
  const sa = await seedContrato(A, 'Roberto Bianchin Barbarini');   // ninguém no resources.resource
  const st = await run(A);
  assert.ok(st.por_nome >= 1, 'usou a chave por nome (sem id)');
  const ref = await refByExtId(A, slugNome('Roberto Bianchin Barbarini'));
  assert.notEqual(ref, null);
  assert.equal(ref.display_name, 'Roberto Bianchin Barbarini');
  assert.equal(await ppid(A, sa), ref.person_id);
});

test('(c) matching por nome é tolerante a caixa/acento/"Prof."', async () => {
  await seedTeacher(A, '888', 'Gabriela Barbosa de Camargo');
  const sa = await seedContrato(A, 'PROF. Gabriela Barbosa de Camargo'); // grafia diferente no Excel
  await run(A);
  const ref = await refByExtId(A, '888');
  assert.notEqual(ref, null, 'casou com o TEACHER apesar da grafia');
  assert.equal(await ppid(A, sa), ref.person_id);
});

test('(d) NÃO sobrescreve professor_person_id já resolvido', async () => {
  // pessoa pré-existente resolvida à mão
  const preId = await withTenant(A, async (c) => (await c.query(
    `INSERT INTO lead_manager.person (tenant_id, display_name) VALUES ($1,'Ja Resolvido') RETURNING id`, [A])).rows[0].id);
  const sa = await seedContrato(A, 'Ja Resolvido', preId);
  await run(A);
  assert.equal(await ppid(A, sa), preId, 'valor humano/dashboard preservado');
});

test('(e) idempotente: 2ª rodada não cria pessoa/ref nem fecha de novo', async () => {
  const st = await run(A);
  assert.equal(st.pessoas_novas, 0);
  assert.equal(st.refs_novos, 0);
  assert.equal(st.contratos_fechados, 0);
  // e um único professor-person por nome (sem duplicar)
  assert.equal(await countProfPersons(A, 'Rafael Leandro Gouveia do Carmo'), 1);
});

test('(f) CROSS-TENANT = 0: professores de A são invisíveis a B', async () => {
  const saB = await seedContrato(B, 'Rafael Leandro Gouveia do Carmo'); // mesmo nome, outro tenant, SEM teacher em B
  const st = await run(B);
  assert.equal(await refByExtId(B, '777'), null, 'não enxerga o id resolvido em A');
  const ref = await refByExtId(B, slugNome('Rafael Leandro Gouveia do Carmo'));
  assert.notEqual(ref, null, 'B cria a SUA própria pessoa/ref (por nome)');
  assert.equal(await ppid(B, saB), ref.person_id);
  assert.ok(st.contratos_fechados >= 1);
});
