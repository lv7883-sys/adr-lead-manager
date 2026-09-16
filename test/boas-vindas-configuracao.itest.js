'use strict';
// boas-vindas-configuracao.itest.js — ADR-050 (E17-04) em PG DESCARTÁVEL (test/run-boas-vindas-itest.sh).
// A unidade monta a PRÓPRIA régua: cria, apaga e reordena mensagens e muda o momento de cada uma.
// Desligado grava com avisos; ligado recusa erro novo; histórico da recepção nunca some.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { pool, withTenant } = require('../src/db');
const configuracao = require('../src/boasVindas/configuracao');

const G = process.env.BV_TENANT_G;   // unidade que monta a régua
const F = process.env.BV_TENANT_F;   // outra unidade (isolamento)
const MODELO = 'escola-de-musica-academia-do-rock';

let adminPool;
const admin = (sql, p) => adminPool.query(sql, p);
const regua = () => withTenant(G, async (c) => (await c.query('SELECT id, ordem, nome, ancora, quando, repeticoes, ativo FROM lead_manager.boas_vindas_etapa ORDER BY ordem')).rows);
const porNome = async (nome) => (await regua()).find((e) => e.nome === nome);
const codigo = (esperado, trecho) => (e) => {
  assert.equal(e.codigo, esperado, `${e.codigo || e.message}: ${JSON.stringify(e.erros)}`);
  if (trecho) assert.ok((e.erros || []).some((m) => m.includes(trecho)), JSON.stringify(e.erros));
  return true;
};

let contaId, pessoaId;
async function toque(etapaId, { rep = 1, status = 'pendente' } = {}) {
  return withTenant(G, async (c) => (await c.query(
    `INSERT INTO lead_manager.boas_vindas_toque (tenant_id, account_id, person_id, etapa_id, repeticao, ancora_data, due_at, versao, phone,
       destinatario_nome, cliente_nome, texto_final, status, enviado_em)
     VALUES ($1,$2,$3,$4,$5, current_date, now(), 'titular', '5519933330000', 'Rui', 'Rui', 'Olá', $6, CASE WHEN $6 = 'enviado' THEN now() END) RETURNING id`,
    [G, contaId, pessoaId, etapaId, rep, status])).rows[0].id);
}
const toquesDa = (etapaId) => admin('SELECT repeticao, status FROM lead_manager.boas_vindas_toque WHERE tenant_id = $1 AND etapa_id = $2 ORDER BY repeticao', [G, etapaId]).then((r) => r.rows);

before(async () => {
  const { Pool } = require('pg');
  adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
  await admin(`INSERT INTO app.franquia (id, slug, lead_tenant_id) VALUES (3, 'unidade-g', $1) ON CONFLICT DO NOTHING`, [G]);
  const w = await withTenant(G, async (c) => ({
    p: (await c.query(`INSERT INTO lead_manager.person (tenant_id, display_name) VALUES ($1, 'Rui') RETURNING id`, [G])).rows[0].id,
    a: (await c.query(`INSERT INTO lead_manager.service_account (tenant_id, status, ini_vigencia) VALUES ($1, 'ativo', current_date) RETURNING id`, [G])).rows[0].id,
  }));
  pessoaId = w.p; contaId = w.a;
  await configuracao.copiarModelo(G, MODELO, 'gestora');
});
after(async () => { await pool.end(); await adminPool.end(); });

test('a tela recebe o que precisa para montar a régua: âncoras da unidade, limites, exemplos e temas sensíveis', async () => {
  const cfg = await configuracao.obter(G);
  assert.deepEqual(cfg.ancorasDisponiveis, ['inicio_contrato', 'atendimento_agendado', 'primeiro_atendimento']);
  assert.deepEqual(cfg.tiposQuando, ['dias', 'vespera', 'proximo_expediente']);
  assert.equal(cfg.limites.maxMensagens, 10);
  assert.equal(cfg.exemplos.cliente, 'Ana');
  const orient = cfg.etapas.find((e) => e.nome === 'Orientações iniciais');
  assert.ok(orient.temas.length >= 1, 'o texto de orientações fala de faltas e reposição → aviso');
  assert.equal(cfg.etapas.find((e) => e.nome === 'Pesquisa de satisfação').temas.length, 0, 'externa não avisa');
  assert.ok(cfg.etapas.every((e) => e.historico === 0));
});

test('desligado: cria mensagem com qualquer momento válido e devolve os avisos da régua', async () => {
  const r = await configuracao.criarEtapa(G, { nome: 'Convite para o sarau', ancora: 'primeiro_atendimento', quando: { tipo: 'dias', valor: 12 }, texto_titular: 'Oi {cliente}, vem pro sarau!' }, 'gestora');
  assert.equal(r.ligada, true);
  assert.ok(Array.isArray(r.avisos));
  const nova = await porNome('Convite para o sarau');
  assert.equal(nova.ordem, 8);
  assert.deepEqual(nova.quando, { tipo: 'dias', valor: 12 });

  await assert.rejects(configuracao.criarEtapa(G, { nome: '', texto_titular: 'x' }), codigo('nome_vazio'));
  await assert.rejects(configuracao.criarEtapa(G, { nome: 'Sem texto' }), codigo('etapa_invalida', 'texto ou de um arquivo'));
  await assert.rejects(configuracao.criarEtapa(G, { nome: 'Véspera errada', ancora: 'inicio_contrato', quando: { tipo: 'vespera' }, texto_titular: 'x' }), codigo('etapa_invalida', 'véspera'));
  await assert.rejects(configuracao.criarEtapa(G, { nome: 'Longe', quando: { tipo: 'dias', valor: 90 }, texto_titular: 'x' }), codigo('etapa_invalida', 'entre 0 e 60'));
});

test('mudar o momento: âncora, tipo e repetições gravam; o que a recepção ainda não tratou sai da fila, o histórico fica', async () => {
  const lembrete = await porNome('Lembrete da aula');
  await toque(lembrete.id, { rep: 1, status: 'enviado' });
  await toque(lembrete.id, { rep: 2, status: 'pendente' });
  const r = await configuracao.salvarEtapa(G, lembrete.id, { quando: { tipo: 'vespera' }, repeticoes: 3 }, 'gestora');
  assert.equal(r.filaRemovidas, 1);
  assert.deepEqual(await toquesDa(lembrete.id), [{ repeticao: 1, status: 'enviado' }]);
  assert.equal((await porNome('Lembrete da aula')).repeticoes, 3);

  // repetição só vale para atendimento agendado: ao mudar a âncora volta a 1
  const sarau = await porNome('Convite para o sarau');
  await configuracao.salvarEtapa(G, sarau.id, { ancora: 'atendimento_agendado', quando: { tipo: 'proximo_expediente' }, repeticoes: 3 });
  const s2 = await porNome('Convite para o sarau');
  assert.equal(s2.ancora, 'atendimento_agendado');
  assert.deepEqual(s2.quando, { tipo: 'proximo_expediente' });
  assert.equal(s2.repeticoes, 3);
  await configuracao.salvarEtapa(G, sarau.id, { ancora: 'inicio_contrato', quando: { tipo: 'dias', valor: 20 } });
  assert.equal((await porNome('Convite para o sarau')).repeticoes, 1);
  await assert.rejects(configuracao.salvarEtapa(G, sarau.id, { quando: { tipo: 'proximo_expediente' } }), codigo('etapa_invalida', 'depois de um atendimento'));

  // só texto não mexe na fila
  await toque(sarau.id);
  assert.equal((await configuracao.salvarEtapa(G, sarau.id, { texto_titular: 'Oi {cliente}, sarau dia 20!' })).filaRemovidas, 0);
  // desligar tira da fila o que não foi tratado
  assert.equal((await configuracao.salvarEtapa(G, sarau.id, { ativo: false })).filaRemovidas, 1);
});

test('mensagem de outro módulo (pesquisa do Diapasão): só nome e ligar/desligar', async () => {
  const nps = await porNome('Pesquisa de satisfação');
  await assert.rejects(configuracao.salvarEtapa(G, nps.id, { quando: { tipo: 'dias', valor: 40 } }), codigo('etapa_externa'));
  await configuracao.salvarEtapa(G, nps.id, { ativo: false });
  assert.equal((await porNome('Pesquisa de satisfação')).ativo, false);
  await configuracao.salvarEtapa(G, nps.id, { ativo: true, nome: 'Pesquisa de 30 dias' });
});

test('ligado: mudança que cria erro de régua é recusada; mensagem nova que quebraria a régua nasce desligada', async () => {
  await configuracao.salvarConfig(G, { modo: 'avisa', variaveis: { link_ead: 'https://ead.g' } });
  const orient = await porNome('Orientações iniciais');
  // 1ª aula + 5 dias cai no mesmo dia do Guia do Aluno (R3)
  await assert.rejects(configuracao.salvarEtapa(G, orient.id, { ancora: 'primeiro_atendimento', quando: { tipo: 'dias', valor: 5 } }), codigo('regua_invalida', 'menos de 2 dias'));
  assert.equal((await porNome('Orientações iniciais')).ancora, 'inicio_contrato', 'nada gravado');

  const r = await configuracao.criarEtapa(G, { nome: 'Colada na boas-vindas', quando: { tipo: 'dias', valor: 1 }, texto_titular: 'Oi de novo' });
  assert.equal(r.ligada, false);
  assert.ok(r.avisos.some((m) => m.includes('menos de 2 dias')), JSON.stringify(r.avisos));
  assert.equal((await porNome('Colada na boas-vindas')).ativo, false);
  // tema sensível só avisa, não bloqueia
  const t = await configuracao.salvarEtapa(G, r.id, { texto_titular: 'Lembrando: o valor da mensalidade vence dia 10.' });
  assert.ok(t.temas.some((x) => x.tema === 'valores'), JSON.stringify(t.temas));
});

test('apagar: só mensagem sem histórico; a posição das outras fica contínua; outra unidade não apaga', async () => {
  const lembrete = await porNome('Lembrete da aula');
  await assert.rejects(configuracao.apagarEtapa(G, lembrete.id), codigo('etapa_com_historico', 'Desligue'));
  const colada = await porNome('Colada na boas-vindas');
  await assert.rejects(configuracao.apagarEtapa(F, colada.id), (e) => e.status === 404);
  await toque(colada.id, { status: 'fora_da_janela' });
  const r = await configuracao.apagarEtapa(G, colada.id, 'gestora');
  assert.equal(r.filaRemovidas, 1);
  const depois = await regua();
  assert.equal(depois.find((e) => e.nome === 'Colada na boas-vindas'), undefined);
  assert.deepEqual(depois.map((e) => e.ordem), depois.map((_, i) => i + 1));
});

test('reordenar: grava a ordem nova; lista incompleta ou de outra unidade é recusada', async () => {
  const antes = await regua();
  const invertida = antes.map((e) => e.id).reverse();
  await configuracao.reordenarEtapas(G, invertida);
  assert.deepEqual((await regua()).map((e) => e.id), invertida);
  await assert.rejects(configuracao.reordenarEtapas(G, invertida.slice(1)), codigo('ordem_invalida'));
  await assert.rejects(configuracao.reordenarEtapas(F, invertida), codigo('ordem_invalida'));
  await configuracao.reordenarEtapas(G, antes.map((e) => e.id));
});

test('limite de 10 mensagens, contando as desligadas', async () => {
  await configuracao.salvarConfig(G, { modo: 'desligado' });
  let n = (await regua()).length;
  while (n < 10) {
    await configuracao.criarEtapa(G, { nome: `Extra ${n}`, quando: { tipo: 'dias', valor: 40 + n }, texto_titular: 'x' });
    n += 1;
  }
  await assert.rejects(configuracao.criarEtapa(G, { nome: 'Uma a mais', texto_titular: 'x' }), codigo('limite_de_mensagens', 'no máximo 10'));
});
