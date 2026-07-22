'use strict';
// sync-cadastro.itest.js — DIFF diário de contratos/alunos (ADR-037 emenda cron). Prova ISOLADA
// (PG descartável) do syncCadastro com snapshot SINTÉTICO (sem Extranet). Invariante de
// proveniência: pessoa passa por aplicar_scraping (trava humana respeitada); contrato escreve
// direto (espelho). NUNCA toca produção.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, withTenant } = require('../src/db');
const { syncCadastro } = require('../src/cadastro/sync-cadastro');

const A = process.env.RESOURCES_TENANT_A;
const B = process.env.RESOURCES_TENANT_B;

const ct = (idC, idA, over = {}) => ({
  idC, idA, curso: 'Violão', status: 'Ativo', ini: '2026-01-01', fim: '2026-12-31',
  planoLabel: 'Anual à vista', periodicidade: 'anual',
  aluno: { idExterno: idA, nome: 'Aluno ' + idA, payerRelation: 'self_paid' }, responsavel: null, ...over });
const sync = (t, contratos) => withTenant(t, (c) => syncCadastro(c, { tenantId: t, snapshot: { contratos } }));

// helpers de leitura (tenant-scoped)
const contrato = (t, idC) => withTenant(t, async (c) => (await c.query(
  `SELECT sa.status, sa.servico_label, sa.plano_label, sa.periodicidade, sa.fonte_ausente_em, sa.last_synced_at
     FROM lead_manager.external_ref er JOIN lead_manager.service_account sa ON sa.id=er.entity_id
    WHERE er.entity_kind='account' AND er.external_type='contrato' AND er.external_id=$1`, [idC])).rows[0] || null);
const pessoa = (t, type, extId) => withTenant(t, async (c) => (await c.query(
  `SELECT p.id, p.display_name, to_char(p.data_nascimento,'YYYY-MM-DD') AS data_nascimento, p.payer_relation
     FROM lead_manager.external_ref er JOIN lead_manager.person p ON p.id=er.entity_id
    WHERE er.entity_kind='person' AND er.external_type=$1 AND er.external_id=$2`, [type, extId])).rows[0] || null);
const bonds = (t, idC) => withTenant(t, async (c) => (await c.query(
  `SELECT am.bond FROM lead_manager.external_ref er JOIN lead_manager.account_member am ON am.account_id=er.entity_id
    WHERE er.external_type='contrato' AND er.external_id=$1 ORDER BY am.bond`, [idC])).rows.map((r) => r.bond));
const divergAtiva = (t, pid, field) => withTenant(t, async (c) => (await c.query(
  `SELECT 1 FROM lead_manager.field_divergence WHERE entity_kind='person' AND entity_id=$1 AND field=$2
      AND dismissed_value IS DISTINCT FROM source_value`, [pid, field])).rowCount > 0);

before(async () => {}); after(async () => { await pool.end(); });

test('(a) NOVO → insere contrato + pessoa + vínculos (self_paid→pagador=aluno)', async () => {
  const st = await sync(A, [ct('C1', 'A1')]);
  assert.equal(st.contratos_novos, 1); assert.equal(st.pessoas_novas, 1);
  const c = await contrato(A, 'C1');
  assert.equal(c.status, 'Ativo'); assert.equal(c.periodicidade, 'anual'); assert.equal(c.plano_label, 'Anual à vista');
  assert.equal(c.fonte_ausente_em, null); assert.notEqual(c.last_synced_at, null);
  const p = await pessoa(A, 'beneficiario', 'A1');
  assert.equal(p.display_name, 'Aluno A1');                 // pessoa nova → nome escrito direto
  assert.deepEqual(await bonds(A, 'C1'), ['beneficiario', 'pagador']);
});

test('(b) MUDANÇA → atualiza (só se mudou); igual → inalterado', async () => {
  const st1 = await sync(A, [ct('C1', 'A1', { status: 'Cancelado', planoLabel: 'Mensal', periodicidade: 'mensal' })]);
  assert.equal(st1.atualizados, 1); assert.equal(st1.contratos_novos, 0);
  const c = await contrato(A, 'C1'); assert.equal(c.status, 'Cancelado'); assert.equal(c.periodicidade, 'mensal');
  const st2 = await sync(A, [ct('C1', 'A1', { status: 'Cancelado', planoLabel: 'Mensal', periodicidade: 'mensal' })]);
  assert.equal(st2.inalterados, 1); assert.equal(st2.atualizados, 0);   // idempotente: não churna
});

test('(c) SUMIÇO → soft-delete (marca, NÃO apaga)', async () => {
  const st = await sync(A, [ct('C2', 'A2')]);              // C1 ausente do snapshot
  assert.equal(st.soft_deleted, 1);
  const c = await contrato(A, 'C1');
  assert.notEqual(c, null);                                 // NÃO deletou a linha
  assert.notEqual(c.fonte_ausente_em, null);                // marcou ausente
});

test('(d) REAPARECE → fonte_ausente_em volta a NULL', async () => {
  const st = await sync(A, [ct('C1', 'A1', { status: 'Cancelado', planoLabel: 'Mensal', periodicidade: 'mensal' }), ct('C2', 'A2')]);
  assert.equal(st.reaparecidos, 1);
  assert.equal((await contrato(A, 'C1')).fonte_ausente_em, null);
});

test('(e) PESSOA travada por humano → scraping NÃO sobrescreve + alerta; campo livre → escreve', async () => {
  // A3 já existe, com nome travado por humano
  const pid = await withTenant(A, async (c) => {
    const p = (await c.query(`INSERT INTO lead_manager.person (tenant_id, display_name) VALUES ($1,'Nome Humano') RETURNING id`, [A])).rows[0].id;
    await c.query(`INSERT INTO lead_manager.external_ref (tenant_id, entity_kind, entity_id, source, external_type, external_id)
                   VALUES ($1,'person',$2,'extranet','beneficiario','A3')`, [A, p]);
    await c.query(`SELECT lead_manager.marcar_edicao_humana('person',$1,'display_name','Nome Humano','recep')`, [p]);
    return p;
  });
  const st = await sync(A, [ct('C3', 'A3', { aluno: { idExterno: 'A3', nome: 'Nome Scraping', dataNascimento: '2010-05-01', payerRelation: 'self_paid' } })]);
  const p = await pessoa(A, 'beneficiario', 'A3');
  assert.equal(p.display_name, 'Nome Humano', 'campo travado NÃO é sobrescrito');
  assert.equal(p.data_nascimento, '2010-05-01', 'campo LIVRE é escrito');
  assert.equal(await divergAtiva(A, pid, 'display_name'), true, 'divergência gerou alerta ativo');
  assert.ok(st.person_divergencia >= 1);
});

test('(f) CONTRATO ignora proveniência: escreve DIRETO mesmo com trava no campo do account', async () => {
  const accId = await withTenant(A, async (c) => (await c.query(
    `SELECT entity_id FROM lead_manager.external_ref WHERE entity_kind='account' AND external_type='contrato' AND external_id='C1'`)).rows[0].entity_id);
  // simula alguém travando um campo do CONTRATO (não deveria existir na prática — contrato é espelho)
  await withTenant(A, (c) => c.query(`SELECT lead_manager.marcar_edicao_humana('account',$1,'status','TRAVADO','x')`, [accId]));
  await sync(A, [ct('C1', 'A1', { status: 'Renovado' }), ct('C2', 'A2'), ct('C3', 'A3', { aluno: { idExterno: 'A3', nome: 'x', payerRelation: 'self_paid' } })]);
  assert.equal((await contrato(A, 'C1')).status, 'Renovado', 'contrato escreve DIRETO (não passa por aplicar_scraping)');
  // e NÃO cria divergência de account (aplicar_scraping nunca é chamado p/ contrato)
  const div = await withTenant(A, (c) => c.query(`SELECT 1 FROM lead_manager.field_divergence WHERE entity_kind='account' AND entity_id=$1`, [accId]));
  assert.equal(div.rowCount, 0, 'contrato não gera alerta de divergência');
});

test('(g) CROSS-TENANT = 0: o que A sincronizou é invisível a B', async () => {
  await sync(B, [ct('C1', 'A1')]);                          // B tem SEU C1/A1, separado
  assert.equal(await contrato(B, 'C2'), null);              // C2 (só de A) invisível a B
  assert.notEqual(await contrato(A, 'C2'), null);           // A intacto
  const pB = await pessoa(B, 'beneficiario', 'A1');
  assert.equal(pB.display_name, 'Aluno A1');                // B criou o seu próprio A1
});
