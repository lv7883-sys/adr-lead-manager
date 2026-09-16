'use strict';
// boas-vindas-migrations.itest.js — ADR-050 (E17-01): migrations 120–125 + db/grants/boas_vindas_agenda_read.sql.
// PG DESCARTÁVEL (ver test/run-boas-vindas-itest.sh), conectado como lead_manager_user — o mesmo papel
// do app em produção, para que RLS e permissões valham de verdade. Cobre: padrões da config (nenhuma
// unidade muda sem configurar), CHECKs, catálogo somente leitura, cópia do modelo, isolamento entre
// unidades (RLS + FK composta), idempotência dos toques, histórico protegido e paridade banco ↔ regras.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool, withTenant } = require('../src/db');
const R = require('../src/boasVindasRegua');

const A = process.env.RESOURCES_TENANT_A;
const B = process.env.RESOURCES_TENANT_B;
const MODELO = 'escola-de-musica-academia-do-rock';

const codigo = (esperado) => (e) => {
  assert.equal(e.code, esperado, `esperava SQLSTATE ${esperado}, veio ${e.code}: ${e.message}`);
  return true;
};

async function seedConta(t) {
  return withTenant(t, async (c) => {
    const pid = (await c.query(`INSERT INTO lead_manager.person (tenant_id, display_name) VALUES ($1,'Pedro') RETURNING id`, [t])).rows[0].id;
    const acc = (await c.query(
      `INSERT INTO lead_manager.service_account (tenant_id, status, servico_label, ini_vigencia, fim_vigencia)
       VALUES ($1,'ativo','Bateria', DATE '2026-09-18', DATE '2027-09-17') RETURNING id`, [t])).rows[0].id;
    return { pid, acc };
  });
}
const etapaDe = (t, ordem) => withTenant(t, async (c) =>
  (await c.query('SELECT id FROM lead_manager.boas_vindas_etapa WHERE ordem = $1', [ordem])).rows[0].id);

after(async () => { await pool.end(); });

test('120: config nasce DESLIGADA, alerta 21, variáveis vazias', async () => {
  const row = await withTenant(A, async (c) => {
    await c.query('INSERT INTO lead_manager.automacao_config (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [A]);
    return (await c.query(
      'SELECT boas_vindas_modo, boas_vindas_alerta_dias, boas_vindas_variaveis, boas_vindas_modelo FROM lead_manager.automacao_config WHERE tenant_id=$1', [A])).rows[0];
  });
  assert.deepEqual(row, { boas_vindas_modo: 'desligado', boas_vindas_alerta_dias: 21, boas_vindas_variaveis: {}, boas_vindas_modelo: null });
});

test('120: CHECKs de modo, faixa do alerta e formato das variáveis', async () => {
  const upd = (sql) => withTenant(A, (c) => c.query(sql, [A]));
  await assert.rejects(upd(`UPDATE lead_manager.automacao_config SET boas_vindas_modo='ligado' WHERE tenant_id=$1`), codigo('23514'));
  await assert.rejects(upd(`UPDATE lead_manager.automacao_config SET boas_vindas_alerta_dias=6 WHERE tenant_id=$1`), codigo('23514'));
  await assert.rejects(upd(`UPDATE lead_manager.automacao_config SET boas_vindas_alerta_dias=31 WHERE tenant_id=$1`), codigo('23514'));
  await assert.rejects(upd(`UPDATE lead_manager.automacao_config SET boas_vindas_variaveis='[]' WHERE tenant_id=$1`), codigo('23514'));
  await upd(`UPDATE lead_manager.automacao_config SET boas_vindas_modo='avisa', boas_vindas_alerta_dias=30,
               boas_vindas_variaveis='{"link_ead":"https://ead.exemplo.com"}' WHERE tenant_id=$1`);
});

test('121/125: catálogo tem 1 modelo com 7 etapas (reaplicar não duplica) e o app só lê', async () => {
  const { rows } = await pool.query(
    `SELECT m.slug, count(e.*)::int AS etapas FROM lead_manager.boas_vindas_modelo m
       JOIN lead_manager.boas_vindas_modelo_etapa e ON e.modelo_slug = m.slug GROUP BY m.slug`);
  assert.deepEqual(rows, [{ slug: MODELO, etapas: 7 }]);
  await assert.rejects(pool.query(`INSERT INTO lead_manager.boas_vindas_modelo (slug, nome) VALUES ('invasor','x')`), codigo('42501'));
  await assert.rejects(pool.query(`UPDATE lead_manager.boas_vindas_modelo_etapa SET nome='x'`), codigo('42501'));
});

test('123: copiar o modelo cria 7 etapas na unidade e não sobrescreve na segunda vez', async () => {
  const n = await withTenant(A, async (c) =>
    (await c.query('SELECT lead_manager.boas_vindas_copiar_modelo($1, $2, $3) AS n', [A, MODELO, 'itest'])).rows[0].n);
  assert.equal(n, 7);
  await assert.rejects(withTenant(A, (c) => c.query('SELECT lead_manager.boas_vindas_copiar_modelo($1, $2)', [A, MODELO])), codigo('23505'));
  await assert.rejects(withTenant(A, (c) => c.query('SELECT lead_manager.boas_vindas_copiar_modelo($1, $2)', [A, 'nao-existe'])), codigo('P0002'));
});

test('123: uma unidade não copia modelo para outra (tenant da sessão manda)', async () => {
  await assert.rejects(withTenant(A, (c) => c.query('SELECT lead_manager.boas_vindas_copiar_modelo($1, $2)', [B, MODELO])), codigo('42501'));
});

test('RLS: a unidade B não enxerga a régua da unidade A', async () => {
  const deB = await withTenant(B, async (c) => (await c.query('SELECT count(*)::int n FROM lead_manager.boas_vindas_etapa')).rows[0].n);
  assert.equal(deB, 0);
  const deA = await withTenant(A, async (c) => (await c.query('SELECT count(*)::int n FROM lead_manager.boas_vindas_etapa')).rows[0].n);
  assert.equal(deA, 7);
});

test('paridade: a régua copiada do banco passa nas travas do código', async () => {
  const etapas = await withTenant(A, async (c) => (await c.query(
    `SELECT id, ordem, nome, ancora, quando, repeticoes, contrato_curto, texto_titular, texto_responsavel,
            anexo_id, entregue_por, ativo FROM lead_manager.boas_vindas_etapa ORDER BY ordem`)).rows);
  const r = R.validarRegua(etapas, { variaveisLivres: ['link_ead', 'link_pesquisa'] });
  assert.deepEqual(r.erros, []);
});

test('123: CHECK estrutural — véspera só com atendimento agendado', async () => {
  await assert.rejects(withTenant(A, (c) => c.query(
    `INSERT INTO lead_manager.boas_vindas_etapa (tenant_id, ordem, nome, ancora, quando, texto_titular)
     VALUES ($1, 9, 'x', 'inicio_contrato', '{"tipo":"vespera"}', 'oi')`, [A])), codigo('23514'));
  // "quando" sem tipo não pode passar pelo CHECK por dar NULL (armadilha clássica de CHECK com OR).
  await assert.rejects(withTenant(A, (c) => c.query(
    `INSERT INTO lead_manager.boas_vindas_etapa (tenant_id, ordem, nome, ancora, quando, texto_titular)
     VALUES ($1, 9, 'x', 'inicio_contrato', '{}', 'oi')`, [A])), codigo('23514'));
});

test('122/123: uma etapa não aponta para o arquivo de outra unidade (FK composta)', async () => {
  const anexoA = await withTenant(A, async (c) => (await c.query(
    `INSERT INTO lead_manager.boas_vindas_anexo (tenant_id, nome_arquivo, mime, tipo, tamanho_bytes, caminho, sha256)
     VALUES ($1, 'guia.pdf', 'application/pdf', 'documento', 2048, 'bv/guia.pdf', repeat('a', 64)) RETURNING id`, [A])).rows[0].id);
  await withTenant(B, (c) => c.query('SELECT lead_manager.boas_vindas_copiar_modelo($1, $2)', [B, MODELO]));
  await assert.rejects(withTenant(B, (c) => c.query(
    'UPDATE lead_manager.boas_vindas_etapa SET anexo_id = $1 WHERE ordem = 5', [anexoA])), codigo('23503'));
  // Na própria unidade, funciona.
  await withTenant(A, (c) => c.query('UPDATE lead_manager.boas_vindas_etapa SET anexo_id = $1 WHERE ordem = 5', [anexoA]));
  // E o arquivo em uso não pode ser apagado.
  await assert.rejects(withTenant(A, (c) => c.query('DELETE FROM lead_manager.boas_vindas_anexo WHERE id = $1', [anexoA])), codigo('23503'));
});

test('124: um toque por contrato × etapa × repetição; remarcar atualiza em vez de duplicar', async () => {
  const { pid, acc } = await seedConta(A);
  const etapa3 = await etapaDe(A, 3);
  const inserir = (rep, due) => withTenant(A, (c) => c.query(
    `INSERT INTO lead_manager.boas_vindas_toque (tenant_id, account_id, person_id, etapa_id, repeticao, ancora_data, due_at, versao, phone)
     VALUES ($1,$2,$3,$4,$5, DATE '2026-09-24', $6, 'titular', '5519999990000')
     ON CONFLICT (tenant_id, account_id, etapa_id, repeticao) DO UPDATE SET due_at = EXCLUDED.due_at, updated_at = now()
     RETURNING id, due_at`, [A, acc, pid, etapa3, rep, due]));
  const r1 = (await inserir(1, '2026-09-23T21:00:00Z')).rows[0];
  const r2 = (await inserir(1, '2026-09-30T21:00:00Z')).rows[0];   // aula remarcada
  assert.equal(r1.id, r2.id, 'mesma linha');
  assert.equal(new Date(r2.due_at).toISOString(), '2026-09-30T21:00:00.000Z');
  await inserir(2, '2026-09-30T21:00:00Z');
  const n = await withTenant(A, async (c) => (await c.query('SELECT count(*)::int n FROM lead_manager.boas_vindas_toque WHERE account_id=$1', [acc])).rows[0].n);
  assert.equal(n, 2);
});

test('124: CHECKs de status — bloqueado explica o motivo, sem telefone só bloqueado, enviado tem data', async () => {
  const { pid, acc } = await seedConta(A);
  const etapa1 = await etapaDe(A, 1);
  const ins = (extra, vals) => withTenant(A, (c) => c.query(
    `INSERT INTO lead_manager.boas_vindas_toque (tenant_id, account_id, person_id, etapa_id, ancora_data, due_at, versao, ${extra.cols})
     VALUES ($1,$2,$3,$4, DATE '2026-09-18', now(), 'titular', ${extra.params})`, [A, acc, pid, etapa1, ...vals]));
  await assert.rejects(ins({ cols: 'phone, status', params: '$5,$6' }, ['55', 'bloqueado']), codigo('23514'));
  await assert.rejects(ins({ cols: 'phone, status', params: '$5,$6' }, [null, 'pendente']), codigo('23514'));
  await assert.rejects(ins({ cols: 'phone, status', params: '$5,$6' }, ['55', 'enviado']), codigo('23514'));
  await ins({ cols: 'phone, status, bloqueio', params: '$5,$6,$7' }, [null, 'bloqueado', 'sem_telefone']);
});

test('123/124: etapa com mensagem registrada não pode ser apagada — só desligada', async () => {
  const etapa3 = await etapaDe(A, 3);
  await assert.rejects(withTenant(A, (c) => c.query('DELETE FROM lead_manager.boas_vindas_etapa WHERE id=$1', [etapa3])), codigo('23503'));
  await withTenant(A, (c) => c.query('UPDATE lead_manager.boas_vindas_etapa SET ativo=false WHERE id=$1', [etapa3]));
});

test('RLS: a unidade B não lê nem grava toques da unidade A', async () => {
  const n = await withTenant(B, async (c) => (await c.query('SELECT count(*)::int n FROM lead_manager.boas_vindas_toque')).rows[0].n);
  assert.equal(n, 0);
  const etapaA = await etapaDe(A, 1);
  const { pid, acc } = await seedConta(A);
  await assert.rejects(withTenant(B, (c) => c.query(
    `INSERT INTO lead_manager.boas_vindas_toque (tenant_id, account_id, person_id, etapa_id, ancora_data, due_at, versao, phone)
     VALUES ($1,$2,$3,$4, DATE '2026-09-18', now(), 'titular', '55')`, [A, acc, pid, etapaA])), codigo('42501'));
});

test('grants: agenda do Scheduler legível; da franquia, só id e lead_tenant_id', { skip: process.env.BV_ITEST_APP !== '1' }, async () => {
  await pool.query('SELECT snapshot FROM app.agenda_snapshot LIMIT 1');
  await pool.query('SELECT id_aluno, id_contrato FROM app.cache_identidade_aula LIMIT 1');
  await pool.query('SELECT id, lead_tenant_id FROM app.franquia LIMIT 1');
  await assert.rejects(pool.query('SELECT * FROM app.franquia LIMIT 1'), codigo('42501'));
  await assert.rejects(pool.query(`UPDATE app.agenda_snapshot SET erro = 'x'`), codigo('42501'));
});
