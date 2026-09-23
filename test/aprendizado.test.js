'use strict';
//
// aprendizado.test.js — "A IA PROPÔS ISTO; A RECEPÇÃO ENVIOU AQUILO."
//
// Este teste protege a única parte arbitrária da régua: onde termina "editou" e começa "escreveu
// do zero". O número que sai daqui vai sustentar a decisão de ligar (ou não) a resposta automática
// aos leads — então ele precisa errar para o lado conservador e ser explicável para o Leo.
//
const test = require('node:test');
const assert = require('node:assert/strict');
const apr = require('../src/aprendizado');

const SUG = 'Olá! Temos aulas de violão para iniciantes às terças e quintas, às 19h. Quer que eu reserve uma aula experimental?';

test('mesmo texto com pontuação/acento/caixa diferentes = ENVIOU IGUAL', () => {
  const enviado = 'ola Temos aulas de violao para iniciantes as tercas e quintas as 19h  Quer que eu reserve uma aula experimental';
  const r = apr.desfechoDaSugestao(SUG, enviado);
  assert.equal(r.desfecho, apr.ENVIOU_IGUAL, `veio ${r.desfecho} com similaridade ${r.similaridade}`);
});

test('mexeu no texto mas manteve a proposta = EDITOU (o material mais valioso)', () => {
  const enviado = 'Oi! Temos aulas de violão para iniciantes às terças e quintas, às 19h30. Posso reservar uma experimental para você?';
  const r = apr.desfechoDaSugestao(SUG, enviado);
  assert.equal(r.desfecho, apr.EDITOU, `veio ${r.desfecho} com similaridade ${r.similaridade}`);
});

test('respondeu outra coisa = ESCREVEU DO ZERO', () => {
  const r = apr.desfechoDaSugestao(SUG, 'Bom dia! O valor da mensalidade é R$ 320 e temos desconto para irmãos.');
  assert.equal(r.desfecho, apr.ESCREVEU_DO_ZERO, `veio ${r.desfecho} com similaridade ${r.similaridade}`);
});

test('ninguém respondeu = NAO_RESPONDEU, e isso NÃO é nota da IA', () => {
  for (const vazio of [null, '', '   ']) {
    const r = apr.desfechoDaSugestao(SUG, vazio);
    assert.equal(r.desfecho, apr.NAO_RESPONDEU);
    assert.equal(r.similaridade, null, 'sem resposta não há similaridade para reportar');
  }
  // e o relatório mantém isso FORA do denominador das taxas
  const rel = apr.relatorio([
    { sugerido: SUG, enviado: SUG, contexto: 'lead' },
    { sugerido: SUG, enviado: null, contexto: 'lead' },
  ]);
  assert.equal(rel.total, 2);
  assert.equal(rel.com_resposta, 1);
  assert.equal(rel.igual_pct, 100, 'quem não respondeu não pode derrubar a taxa de acerto da IA');
});

test('frase reordenada continua sendo a MESMA resposta (não vira "do zero")', () => {
  // distância de edição diria "texto completamente diferente"; para a pergunta que importa
  // — a IA acertou? — reordenar duas frases é edição, não reescrita.
  const enviado = 'Quer que eu reserve uma aula experimental? Temos aulas de violão para iniciantes às terças e quintas, às 19h.';
  const r = apr.desfechoDaSugestao(SUG, enviado);
  assert.notEqual(r.desfecho, apr.ESCREVEU_DO_ZERO, `veio ${r.desfecho} com similaridade ${r.similaridade}`);
});

test('emoji NÃO é ignorado na comparação — tom é o que a unidade configura', () => {
  const semEmoji = 'Vamos marcar sua aula experimental';
  const comEmoji = 'Vamos marcar sua aula experimental 🎸🎶😀';
  assert.ok(apr.similaridade(semEmoji, comEmoji) < 1, 'tirar emoji é uma edição de tom, e precisa aparecer como edição');
});

test('relatório fatia por contexto — é assim que se decide o que ligar primeiro', () => {
  const rel = apr.relatorio([
    { sugerido: SUG, enviado: SUG, contexto: 'lead' },
    { sugerido: SUG, enviado: SUG, contexto: 'lead' },
    { sugerido: SUG, enviado: 'Bom dia, o valor é R$ 320.', contexto: 'renovacao' },
  ]);
  assert.equal(rel.por_contexto.lead[apr.ENVIOU_IGUAL], 2);
  assert.equal(rel.por_contexto.renovacao[apr.ESCREVEU_DO_ZERO], 1);
  assert.equal(rel.aproveitamento_pct, 66.7, 'igual + editado sobre quem respondeu');
});

test('a consulta casa a PRIMEIRA saída dentro da janela, e a janela é explícita', () => {
  const sql = apr.sqlSugestoesComResposta({ janelaHoras: 6 });
  assert.match(sql, /make_interval\(hours => 6\)/);
  assert.match(sql, /ORDER BY so\.received_at ASC LIMIT 1/, 'a primeira resposta, não a última');
  assert.match(sql, /so\.received_at >\s+s\.criada_em/, 'só o que veio DEPOIS da sugestão');
  // o casamento do contato é por dígitos, como o resto do LM
  assert.match(sql, /regexp_replace\(so\.external_id/);
});

test('sugestão vazia dos dois lados não inventa acerto', () => {
  assert.equal(apr.desfechoDaSugestao('', '').desfecho, apr.NAO_RESPONDEU);
  assert.equal(apr.similaridade('', 'qualquer coisa'), 0);
});
