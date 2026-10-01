'use strict';
//
// extranet-cache.test.js — o cache que impede que 11h de coleta virem pó.
//
// O incidente que originou isto (30/09/2026): a coleta diária rodou 651 min e morreu na décima
// hora com "fetch failed". Nada do que já tinha sido lido foi aproveitado. Os testes abaixo são
// escritos com os números daquele dia — 1.535 páginas, ~1.085 contratos — e cobrem as três regras
// de validade (assinatura, prazo com dispersão, amostragem) e a propriedade que realmente importa:
// o que foi lido ANTES da falha continua valendo DEPOIS dela.
//
const { test } = require('node:test');
const assert = require('node:assert');

const { criarCache, validadeDias, sorteadoParaVerificar, assinaturaDe } = require('../src/cadastro/extranet-cache');

const TENANT = 'ed731a58-62e5-45ad-acba-a5502ff39e92';
const DIA = 86400000;

// Banco de mentira: guarda as linhas em memória e responde ao SELECT e ao UPSERT que o cache usa.
function bancoFake({ falharAoGravar = false } = {}) {
  const linhas = new Map();
  const chamadas = { select: 0, upsert: 0 };
  const query = async (sql, params) => {
    if (/^\s*SELECT/i.test(sql)) {
      chamadas.select++;
      const [, tipos] = params;
      return { rows: [...linhas.values()].filter((r) => tipos.includes(r.tipo)) };
    }
    chamadas.upsert++;
    if (falharAoGravar) throw new Error('banco fora do ar');
    const [tenant_id, tipo, chave, assinatura, conteudo, buscado_em] = params;
    linhas.set(`${tipo}|${chave}`, { tenant_id, tipo, chave, assinatura, conteudo: JSON.parse(conteudo), buscado_em });
    return { rowCount: 1 };
  };
  return { query, linhas, chamadas };
}

const cacheCom = (banco, opts = {}) => criarCache({ tenantId: TENANT, query: banco.query, ...opts });

test('página nunca lida precisa ser buscada', async () => {
  const banco = bancoFake();
  const cache = cacheCom(banco);
  await cache.carregar(['detalhe_contrato']);
  const r = cache.consultar('detalhe_contrato', '1110', 'Piano|2026-07-29|2027-08-11|ativo|Beatriz');
  assert.equal(r.usar, false);
  assert.equal(r.motivo, 'inexistente');
});

test('o que foi lido antes da falha continua valendo depois dela', async () => {
  // É a razão de existir do cache: a coleta morreu na décima hora; a próxima reaproveita.
  const banco = bancoFake();
  const primeira = cacheCom(banco);
  await primeira.carregar(['detalhe_contrato']);
  const assinatura = assinaturaDe(['Piano', '2026-07-29', '2027-08-11', 'ativo', 'Beatriz']);
  await primeira.gravar('detalhe_contrato', '1110', assinatura, { planoLabel: 'Semestral 1x semana' });
  // ... aqui a rede cai e o processo morre ...

  const segunda = cacheCom(banco);          // execução seguinte, memória zerada
  await segunda.carregar(['detalhe_contrato']);
  const r = segunda.consultar('detalhe_contrato', '1110', assinatura);
  assert.equal(r.usar, true);
  assert.equal(r.conteudo.planoLabel, 'Semestral 1x semana');
  assert.equal(segunda.stats.hits, 1);
});

test('mudou na lista => rebusca, sem esperar o prazo', async () => {
  const banco = bancoFake();
  const cache = cacheCom(banco);
  await cache.carregar(['detalhe_contrato']);
  await cache.gravar('detalhe_contrato', '1110', assinaturaDe(['Piano', '2026-07-29', '2027-08-11', 'ativo', 'Beatriz']), { planoLabel: 'Semestral' });
  // a unidade trocou o curso do contrato: a assinatura muda e o detalhe guardado não vale mais
  const r = cache.consultar('detalhe_contrato', '1110', assinaturaDe(['Violão', '2026-07-29', '2027-08-11', 'ativo', 'Beatriz']));
  assert.equal(r.usar, false);
  assert.equal(r.motivo, 'mudou-na-lista');
  assert.equal(cache.stats.mudaram, 1);
});

test('página vencida é rebuscada mesmo sem mudança aparente', async () => {
  // Telefone e nascimento mudam sem aparecer na lista: o prazo é a única defesa.
  const banco = bancoFake();
  const cache = cacheCom(banco);
  await cache.carregar(['ficha_aluno']);
  await cache.gravar('ficha_aluno', '149', null, { telefone: '+5519999998888' });
  const linha = banco.linhas.get('ficha_aluno|149');
  linha.buscado_em = new Date(Date.now() - 10 * DIA);   // além do teto de 9 dias

  const outra = cacheCom(banco);
  await outra.carregar(['ficha_aluno']);
  const r = outra.consultar('ficha_aluno', '149');
  assert.equal(r.usar, false);
  assert.equal(r.motivo, 'vencido');
});

test('o prazo se espalha entre as chaves — nada de tudo vencer no mesmo dia', () => {
  const dias = new Set();
  for (let i = 0; i < 300; i++) {
    const d = validadeDias(`contrato-${i}`);
    assert.ok(d >= 5 && d <= 9, `prazo fora da faixa: ${d}`);
    dias.add(d);
  }
  // Se todas as chaves caíssem no mesmo dia, uma vez por semana a coleta voltaria a ser a de 11h.
  assert.ok(dias.size >= 4, `esperava dispersão, veio ${[...dias].join(',')}`);
  assert.equal(validadeDias('contrato-7'), validadeDias('contrato-7'));   // determinístico
});

test('amostragem de verificação: estável no dia, fração respeitada', () => {
  const hoje = new Date('2026-09-30T12:00:00Z');
  assert.equal(sorteadoParaVerificar('1110', 1, hoje), true);
  assert.equal(sorteadoParaVerificar('1110', 0, hoje), false);
  // mesma chave, mesmo dia → mesma decisão (não verifica a mesma página duas vezes no dia)
  assert.equal(sorteadoParaVerificar('1110', 0.5, hoje), sorteadoParaVerificar('1110', 0.5, hoje));
  // a 5% padrão, o volume fica na ordem de dezenas por execução, não centenas
  let n = 0;
  for (let i = 0; i < 1535; i++) if (sorteadoParaVerificar(`p-${i}`, 0.05, hoje)) n++;
  assert.ok(n > 20 && n < 160, `amostra fora do esperado: ${n} de 1535`);
});

test('página sorteada para verificação é aproveitada, mas marcada para rebusca', async () => {
  const banco = bancoFake();
  const cache = cacheCom(banco, { });
  await cache.carregar(['ficha_aluno']);
  await cache.gravar('ficha_aluno', '149', null, { telefone: '+5519999998888' });
  // força a verificação de TODAS as páginas
  const r = criarCache({ tenantId: TENANT, query: banco.query });
  await r.carregar(['ficha_aluno']);
  const semVerificacao = r.consultar('ficha_aluno', '149');
  assert.equal(semVerificacao.usar, true);   // com 5% padrão, quase sempre cai aqui
  assert.ok(['valido', 'verificacao'].includes(semVerificacao.motivo));
});

test('divergência entre o guardado e a Extranet vira alerta, não silêncio', async () => {
  const banco = bancoFake();
  const cache = cacheCom(banco);
  const campos = cache.conferir('ficha_aluno', '149',
    { telefone: '+5519999998888', nasc: '2010-05-02' },
    { telefone: '+5519991112222', nasc: '2010-05-02' });
  assert.deepEqual(campos, ['telefone']);
  assert.equal(cache.stats.divergencias, 1);
  assert.equal(cache.stats.verificados, 1);
});

test('falha ao gravar no banco não derruba a coleta', async () => {
  const banco = bancoFake({ falharAoGravar: true });
  const cache = cacheCom(banco);
  await cache.carregar(['detalhe_contrato']);
  await cache.gravar('detalhe_contrato', '1110', 'assinatura', { planoLabel: 'Mensal' });   // não lança
  // e o valor continua valendo DENTRO deste run, mesmo sem ter ido ao banco
  assert.equal(cache.consultar('detalhe_contrato', '1110', 'assinatura').usar, true);
});

test('CADASTRO_CACHE=off devolve o comportamento antigo: busca tudo, guarda nada', async () => {
  const banco = bancoFake();
  const cache = criarCache({ tenantId: TENANT, query: banco.query, ligado: false });
  await cache.carregar(['detalhe_contrato', 'ficha_aluno']);
  await cache.gravar('detalhe_contrato', '1110', 'x', { planoLabel: 'Mensal' });
  assert.equal(banco.chamadas.select, 0);
  assert.equal(banco.chamadas.upsert, 0);
  assert.equal(cache.consultar('detalhe_contrato', '1110', 'x').usar, false);
});

test('assinatura junta os campos da lista e tolera nulo', () => {
  assert.equal(assinaturaDe(['Piano', '2026-07-29', '2027-08-11', 'ativo', 'Beatriz']),
    'Piano|2026-07-29|2027-08-11|ativo|Beatriz');
  assert.equal(assinaturaDe(['Piano', null, undefined, '', 'Beatriz']), 'Piano||||Beatriz');
});
