'use strict';

// ADR-030 Passo 2 — gate determinístico da SAÍDA (puro, sem DB). Trava os exemplos reais
// do recon: enrolação óbvia -> ENROLOU; pergunta limpa ao cliente -> PASSOU_BOLA; o resto
// (frase longa com promessa, afirmação sem "?", "?"+enrolação) -> AMBIGUO (cai na Camada 2).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gateSaida } = require('../src/bolaGate');

const ENROLOU = [
  'Opa, claro! Já te dou um retorno sobre a bateria!!',
  'Assim que tivermos um retorno a gente te avisa.',
  'Vou verificar com ela e te retorno.',
  'Vou confirmar o horário das 18h, um minutinho.',
  '*Rafaela* Oi, Rosa! Vou verificar e te aviso.',
];
const PASSOU = [
  'Seria para você mesma?',
  'Você dá aulas de qual(is) intrumento(s)?',
  'Só confirmando: você só retorna agora em agosto, certo?',
];
// Ambíguos: têm promessa mas com info/tamanho (1,5) ou afirmação sem "?" (10) -> Camada 2.
const AMBIGUO = [
  'Vou checar aqui certinho como ficarão os valores do cancelamento e te envio logo mais.',
  'Vou ver quando a Klara irá retornar, no período em que ela não vier, podemos colocar a aula dele às 16h.',
  'Temos aulas de piano sim!',
];

test('gate: enrolação curta e sem "?" -> ENROLOU', () => {
  for (const t of ENROLOU) assert.equal(gateSaida(t), 'enrolou', t);
});
test('gate: pergunta limpa ao cliente -> PASSOU_BOLA', () => {
  for (const t of PASSOU) assert.equal(gateSaida(t), 'passou_bola', t);
});
test('gate: promessa longa / afirmação sem "?" -> AMBIGUO (Camada 2)', () => {
  for (const t of AMBIGUO) assert.equal(gateSaida(t), 'ambiguo', t);
});
test('gate: "?" sozinho NÃO decide — "?" + enrolação vira AMBIGUO', () => {
  assert.equal(gateSaida('Vou verificar isso pra você?'), 'ambiguo');
});
