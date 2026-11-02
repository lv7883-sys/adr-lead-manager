'use strict';
//
// CAMADA 1 da conferência do seed de demonstração, como TESTE: o plano inteiro contra o esquema
// REAL, congelado de produção por `deploy/dump-esquema-demo.js`.
//
// POR QUE ISTO É UM ARQUIVO SEPARADO
//
// Porque depende de um arquivo GERADO. Os testes de demo-mf8.test.js rodam em qualquer máquina,
// a qualquer momento; este só vale se o dump existir e for recente. Misturar os dois faria o
// conjunto ter duas naturezas diferentes com a mesma cara — e a diferença importa: um diz "o
// cenário é coerente", o outro diz "o cenário cabe no banco que existe hoje".
//
// SE O DUMP NÃO EXISTIR, ESTE TESTE FALHA. De propósito. A alternativa seria pular com um aviso,
// e aviso em suíte verde não é lido. O que a camada 1 afirma é sobre PRODUÇÃO, e afirmação sobre
// produção sem fonte nem data não é afirmação — é chute com cara de prova.
//
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cenario = require('../src/demo/cenario-mf8');
const demo = require('../src/demo/tenant-demo');
const { confere } = require('../src/demo/conformidade');

const ARQ = path.join(__dirname, 'fixtures', 'esquema-demo.json');
const TENANT = '11111111-2222-4333-8444-555555555555';
const HOJE = '2026-11-04';

function esquema() {
  if (!fs.existsSync(ARQ)) {
    assert.fail(
      `O esquema congelado não existe (${ARQ}).\n\n`
      + 'Gere-o contra o banco onde o seed vai rodar:\n'
      + '  node deploy/dump-esquema-demo.js\n\n'
      + 'Sem ele a CAMADA 1 não confere nada — e este teste não vai passar fingindo que conferiu. '
      + 'Ler as restrições das migrações no lugar do banco MENTE: a 092 define '
      + "CHECK (marco IN ('D-10','D-2')) e a 109 a troca por seis valores.");
  }
  return JSON.parse(fs.readFileSync(ARQ, 'utf8'));
}

const planoDoCenario = () => cenario.plano({ tenantId: TENANT, hoje: HOJE });
const planoDoProvisionamento = () => demo.planoProvisionamento({
  tenantId: TENANT, hoje: HOJE, slug: 'clinica-exemplo',
  maisDias: cenario.maisDias, instante: cenario.instante,
});

test('o esquema congelado diz DE ONDE veio e QUANDO', () => {
  const e = esquema();
  assert.ok(e._meta, 'sem _meta não há procedência');
  assert.ok(e._meta.banco, 'o dump precisa dizer de qual banco veio');
  assert.ok(Date.parse(e._meta.gerado_em), 'o dump precisa dizer quando foi gerado');
  assert.deepEqual(e._meta.tabelas_ausentes, [],
    'há tabela do plano que NÃO EXISTE no banco de onde o dump veio — o seed não roda lá');
});

test('TODA tabela dos dois planos está no esquema congelado (lista derivada, não digitada)', () => {
  const e = esquema();
  const pedidas = [...new Set([
    ...cenario.tabelasDoPlano(planoDoCenario()),
    ...cenario.tabelasDoPlano(planoDoProvisionamento()),
  ])];
  const faltando = pedidas.filter((t) => !e.tabelas[t]);
  assert.deepEqual(faltando, [],
    `tabelas no plano e fora do esquema congelado: ${faltando.join(', ')} — refaça o dump`);
  // 14: as 10 do cenário + as 4 do provisionamento. O número está escrito para que crescer o
  // cenário sem refazer o dump dê ERRO, em vez de passar com a tabela nova sem conferência.
  assert.equal(pedidas.length, 14);
});

test('CAMADA 1: o plano do CENÁRIO passa nas restrições CHECK reais', () => {
  const r = confere(planoDoCenario(), esquema());
  assert.deepEqual(r.problemas, []);
  assert.equal(r.conferido.tabelas, 10);
  assert.ok(r.conferido.linhas > 90, `conferiu só ${r.conferido.linhas} linhas`);
  assert.ok(r.conferido.checks > 0, 'nenhuma restrição avaliada — o dump trouxe CHECKs?');
});

test('CAMADA 1: o plano do PROVISIONAMENTO passa nas restrições CHECK reais', () => {
  const r = confere(planoDoProvisionamento(), esquema());
  assert.deepEqual(r.problemas, []);
  assert.equal(r.conferido.tabelas, 4);
});

test('as colunas GERADAS do banco não são escritas por nenhum dos planos', () => {
  // `conversations.br_key` e `contact_point.br_key` (migr 112) são GENERATED ALWAYS. São elas que
  // casam conversa × cadastro na aba Renovações — e INSERT nelas é erro do banco, não aviso.
  const e = esquema();
  const geradas = [];
  for (const [tab, meta] of Object.entries(e.tabelas)) {
    for (const [col, c] of Object.entries(meta.colunas)) if (c.gerada) geradas.push(`${tab}.${col}`);
  }
  assert.ok(geradas.length > 0, 'o dump não trouxe nenhuma coluna gerada — conferir o dump');
  for (const p of [planoDoCenario(), planoDoProvisionamento()]) {
    for (const b of p) {
      for (const col of b.colunas) {
        assert.ok(!geradas.includes(`${b.tabela}.${col}`), `${b.tabela}.${col} é gerada e está no plano`);
      }
    }
  }
});

test('restrições NÃO VALIDADAS do banco aparecem registradas — elas valem para linha nova', () => {
  // NOT VALID não confere o que já está lá, mas vale para o que o seed GRAVA. Se o dump achar
  // alguma, ela tem de estar visível em vez de parecer uma restrição comum.
  const e = esquema();
  const naoValidadas = Object.entries(e.tabelas)
    .filter(([, m]) => m.naoValidadas && m.naoValidadas.length)
    .map(([t, m]) => `${t}: ${m.naoValidadas.join(', ')}`);
  // Não é uma proibição — é um registro. O teste passa com ou sem; o valor está em ficar escrito.
  assert.ok(Array.isArray(naoValidadas));
  if (naoValidadas.length) console.log(`  restrições NOT VALID no alvo: ${naoValidadas.join(' | ')}`);
});
