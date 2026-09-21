'use strict';
// ia-wrapper.test.js — o ponto único de IA: mede na conta certa, denuncia custo órfão,
// e NUNCA atrapalha a chamada. Sem banco e sem rede: o consumo é espionado por injeção.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'chave-de-teste';

const consumo = require('../src/plataforma/consumo');
const contexto = require('../src/plataforma/contexto');
const ia = require('../src/plataforma/ia');

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let gravados;
const registrarUsoReal = consumo.registrarUso;

beforeEach(() => {
  gravados = [];
  ia._reiniciar();
  consumo.registrarUso = async (tenantId, modulo, tipo, quantidade, opcoes) => {
    gravados.push({ tenantId, modulo, tipo, quantidade, ref: opcoes && opcoes.ref });
    return true;
  };
});

// `finally` no wrapper garante que a medição acontece depois da resposta; um tick basta.
const assentar = () => new Promise((r) => setImmediate(r));

test('cobra da unidade dona do trabalho', async () => {
  const r = await contexto.comUnidade(A, { modulo: 'LEADS' }, () =>
    ia.medir({ ref: 'msg-1' }, async () => 'resposta'));
  await assentar();
  assert.equal(r, 'resposta');
  assert.deepEqual(gravados, [{ tenantId: A, modulo: 'LEADS', tipo: 'ia_texto', quantidade: 1, ref: 'msg-1' }]);
});

test('duas unidades, duas contas — uma nunca paga pela outra', async () => {
  await contexto.comUnidade(A, () => ia.medir({}, async () => 1));
  await contexto.comUnidade(B, () => ia.medir({}, async () => 2));
  await assentar();
  assert.deepEqual(gravados.map((g) => g.tenantId), [A, B]);
});

test('o contexto atravessa await, callback e chamada aninhada', async () => {
  // é isto que permite não passar tenantId por 12 arquivos: se o contexto se perdesse
  // no meio do caminho, a chamada lá no fundo viraria custo órfão.
  async function fundo() {
    await new Promise((r) => setTimeout(r, 1));
    return ia.medir({}, async () => 'ok');
  }
  async function meio() { await new Promise((r) => setImmediate(r)); return fundo(); }
  await contexto.comUnidade(A, { modulo: 'MARKETING' }, meio);
  await assentar();
  assert.equal(gravados.length, 1);
  assert.equal(gravados[0].tenantId, A);
  assert.equal(gravados[0].modulo, 'MARKETING', 'o módulo do contexto deve chegar na cobrança');
});

test('chamada SEM dono não cobra ninguém e é denunciada como custo órfão', async () => {
  const r = await ia.medir({}, async () => 'sem dono');
  await assentar();
  assert.equal(r, 'sem dono');
  assert.deepEqual(gravados, [], 'não pode cobrar de uma unidade qualquer');
  assert.equal(ia._estado().orfaos, 1, 'tem de contar o órfão para alguém consertar');
});

test('chamada que FALHOU também é cobrada (o provedor cobra a tentativa)', async () => {
  await assert.rejects(
    contexto.comUnidade(A, () => ia.medir({}, async () => { throw new Error('429 rate limit'); })),
    /429/);
  await assentar();
  assert.equal(gravados.length, 1, 'tentativa falha custa dinheiro e precisa aparecer na conta');
});

test('erro ao gravar o consumo NÃO derruba a chamada de IA', async () => {
  consumo.registrarUso = async () => { throw new Error('relation "consumo_evento" does not exist'); };
  const r = await contexto.comUnidade(A, () => ia.medir({}, async () => 'resposta vale mais'));
  await assentar();
  assert.equal(r, 'resposta vale mais');
  assert.equal(ia._estado().gravacaoDesligada, true, 'depois da 1ª falha, para de tentar e para de poluir o log');
});

test('medição desligada não volta a tentar sozinha', async () => {
  consumo.registrarUso = async () => { throw new Error('falha'); };
  await contexto.comUnidade(A, () => ia.medir({}, async () => 1));
  await assentar();
  consumo.registrarUso = async (...a) => { gravados.push(a); return true; };
  await contexto.comUnidade(A, () => ia.medir({}, async () => 2));
  await assentar();
  assert.deepEqual(gravados, [], 'uma vez desligada, só religa em processo novo');
});

test('comUnidade sem unidade não inventa dono', async () => {
  await contexto.comUnidade(null, () => ia.medir({}, async () => 1));
  await assentar();
  assert.deepEqual(gravados, []);
  assert.equal(ia._estado().orfaos, 1);
  assert.equal(contexto.unidadeAtual(), null, 'fora de comUnidade não há dono');
});

test('o tipo medido default é chamada de texto, e pode ser trocado', async () => {
  await contexto.comUnidade(A, () => ia.medir({ tipo: consumo.TIPOS.TRANSCRICAO_SEG, quantidade: 42 }, async () => 1));
  await assentar();
  assert.equal(gravados[0].tipo, 'transcricao_seg');
  assert.equal(gravados[0].quantidade, 42);
  consumo.registrarUso = registrarUsoReal;   // devolve o módulo como estava
});
