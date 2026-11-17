'use strict';

// Cronômetro da entrada (migr 192 / src/ingestaoLatencia.js). Teste PURO, sem banco.
//
// O que ele protege, e por quê — cada bloco nasceu de uma forma específica de a medição mentir:
//
//   1. percentil sem interpolação: um p95 interpolado devolve um tempo que NENHUMA mensagem
//      levou. Em latência isso é inventar o dado que se foi medir.
//   2. fila negativa preservada: relógios diferentes discordam. Zerar o negativo esconderia o
//      desvio e faria a fila parecer sempre saudável.
//   3. resumir() separando "lead novo" do resto: é a confusão que responderia a pergunta errada
//      com um número bonito — mensagem de aluno afunda a mediana e não há nada a avisar nela.
//   4. zero linhas devolve zero/null, nunca um número plausível.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { iniciar, percentil, filaMs, filaPlausivel, resumir } = require('../src/ingestaoLatencia');

test('percentil é nearest-rank: devolve um valor que existe na amostra', () => {
  const v = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  assert.equal(percentil(v, 50), 500);     // 5º de 10 — não 550 (interpolado)
  assert.equal(percentil(v, 90), 900);
  assert.equal(percentil(v, 95), 1000);
  assert.equal(percentil(v, 100), 1000);
  // E o invariante que vale para qualquer amostra: o resultado É um dos valores medidos.
  for (const p of [1, 25, 50, 75, 99, 100]) assert.ok(v.includes(percentil(v, p)));
});

test('percentil de amostra vazia é null, nunca 0', () => {
  // 0 ms seria lido como "instantâneo" — a mentira mais cara deste painel.
  assert.equal(percentil([], 50), null);
  assert.equal(percentil(null, 95), null);
  assert.equal(percentil([NaN, undefined], 50), null);
});

test('percentil de um valor só devolve esse valor em qualquer p', () => {
  assert.equal(percentil([42], 50), 42);
  assert.equal(percentil([42], 95), 42);
});

test('fila preserva o negativo (desvio de relógio) em vez de zerar', () => {
  const recebido = 1_000_000_000_000;              // nosso relógio, em ms
  // WhatsApp diz que foi enviada 2s DEPOIS de termos recebido: relógios discordando.
  assert.equal(filaMs((recebido + 2000) / 1000, recebido), -2000);
  assert.equal(filaPlausivel(-2000), false);
  // caso normal: 3s de fila
  assert.equal(filaMs((recebido - 3000) / 1000, recebido), 3000);
  assert.equal(filaPlausivel(3000), true);
  // sem timestamp não inventa zero
  assert.equal(filaMs(null, recebido), null);
  assert.equal(filaMs(0, recebido), null);
  // backfill de histórico (2 dias) não é latência
  assert.equal(filaPlausivel(2 * 24 * 60 * 60 * 1000), false);
});

test('resumir separa lead novo do resto — é a pergunta que decide o desenho', () => {
  const linhas = [
    // três mensagens que viraram lead novo: 2s, 4s, 30s
    { total_ms: 2000, funil_ms: 1800, lead_novo: true, tem_midia: false, fila_ms: 500 },
    { total_ms: 4000, funil_ms: 3500, lead_novo: true, tem_midia: false, fila_ms: 700 },
    { total_ms: 30000, funil_ms: 29000, lead_novo: true, tem_midia: true, midia_ms: 20000, fila_ms: 900 },
    // duas de quem já é aluno: rápidas, e SEM nada a avisar
    { total_ms: 100, funil_ms: 90, lead_novo: false, tem_midia: false, fila_ms: 400 },
    { total_ms: 120, funil_ms: 110, lead_novo: false, tem_midia: false, fila_ms: 400 },
  ];
  const r = resumir(linhas);
  assert.equal(r.mensagens, 5);
  assert.equal(r.leads_novos, 3);
  assert.equal(r.com_midia, 1);
  // O número que decide usa SÓ os 3 leads novos: p50 = 4000, não os 120ms das mensagens de aluno.
  assert.equal(r.total_lead_novo.n, 3);
  assert.equal(r.total_lead_novo.p50, 4000);
  assert.equal(r.total_lead_novo.max, 30000);
  // Se alguém misturar tudo, o p50 cai para 2000 e a conclusão vira outra — é o erro travado aqui.
  assert.equal(r.total_todas.p50, 2000);
  assert.notEqual(r.total_lead_novo.p50, r.total_todas.p50);
});

test('resumir conta as medições de fila descartadas por relógio, em vez de escondê-las', () => {
  const r = resumir([
    { total_ms: 1000, lead_novo: true, tem_midia: false, fila_ms: 500 },
    { total_ms: 1000, lead_novo: true, tem_midia: false, fila_ms: -4000 },           // relógio torto
    { total_ms: 1000, lead_novo: true, tem_midia: false, fila_ms: 7 * 3600 * 1000 }, // backfill
  ]);
  assert.equal(r.fila.n, 1);
  assert.equal(r.fila.p50, 500);
  assert.equal(r.fila.descartadas_por_relogio, 2);
});

test('resumir de lista vazia não inventa número', () => {
  const r = resumir([]);
  assert.equal(r.mensagens, 0);
  assert.equal(r.leads_novos, 0);
  assert.equal(r.total_lead_novo.p50, null);
  assert.equal(r.total_lead_novo.n, 0);
});

test('o cronômetro mede cada fase desde a anterior, não desde o início', () => {
  const cron = iniciar(1000);
  cron.fase('origem_ms', 1050);   // 50ms
  cron.fase('midia_ms', 1250);    // 200ms (não 250)
  cron.fase('funil_ms', 4250);    // 3000ms
  assert.equal(cron.fases.origem_ms, 50);
  assert.equal(cron.fases.midia_ms, 200);
  assert.equal(cron.fases.funil_ms, 3000);
  assert.equal(cron.totalMs(4250), 3250);
  // A soma das fases nunca passa do total — se passar, alguma fase foi contada duas vezes.
  const soma = Object.values(cron.fases).reduce((a, b) => a + b, 0);
  assert.ok(soma <= cron.totalMs(4250));
});
