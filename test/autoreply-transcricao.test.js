'use strict';
// autoreply-transcricao.test.js — o histórico que a resposta automática entrega à IA (sem DB).
// Incidente (11/09/2026): a Janis respondia como se fosse a recepcionista ("o contrato que enviei",
// respondendo a um "Bom dia, Kessia"). No histórico real TODA saída da recepção vem como ASSISTANT, e
// a IA as lia como falas DELA. A transcrição legendada separa quem falou o quê.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { montarTranscricao } = require('../src/autoReply');

const NOME_IA = 'Janis J. (assistente virtual)';

test('cliente, recepção e a própria assistente ficam com legendas diferentes', () => {
  const t = montarTranscricao([
    { role: 'USER', content: 'Bom dia, Kessia! Recebeu o contrato?' },
    { role: 'ASSISTANT', content: '*Késsia*\nOi Regina! Te enviei o contrato por e-mail.' },
    { role: 'ASSISTANT', content: '*Janis J. (assistente virtual)*\nOi! A equipe retorna às 9h.' },
  ], NOME_IA);
  assert.equal(t, [
    '[CLIENTE] Bom dia, Kessia! Recebeu o contrato?',
    '[RECEPÇÃO] Oi Regina! Te enviei o contrato por e-mail.',
    '[VOCÊ] Oi! A equipe retorna às 9h.',
  ].join('\n'));
});

test('a assinatura de quem atende sai; sugestão aprovada (sem assinatura) também é RECEPÇÃO', () => {
  const t = montarTranscricao([
    { role: 'ASSISTANT', content: '*Rafa*\nOii Laís! Segue o boleto' },
    { role: 'ASSISTANT', content: 'Perfeito! Te espero quarta 😊' },   // pending_approval aprovada pela recepção
  ], NOME_IA);
  assert.equal(t, '[RECEPÇÃO] Oii Laís! Segue o boleto\n[RECEPÇÃO] Perfeito! Te espero quarta 😊');
  assert.doesNotMatch(t, /Rafa/);
});

test('quebra de linha vira " / ", mensagem longa é cortada e o histórico fica nas últimas N', () => {
  const longa = 'a'.repeat(700);
  const t = montarTranscricao([
    { role: 'USER', content: 'linha 1\nlinha 2' },
    { role: 'USER', content: longa },
  ], NOME_IA);
  assert.equal(t.split('\n')[0], '[CLIENTE] linha 1 / linha 2');
  assert.equal(t.split('\n')[1].length, '[CLIENTE] '.length + 600 + 1, '600 caracteres + reticências');
  const muitas = Array.from({ length: 50 }, (_, i) => ({ role: 'USER', content: 'msg ' + i }));
  const t2 = montarTranscricao(muitas, NOME_IA).split('\n');
  assert.equal(t2.length, 40); assert.equal(t2[0], '[CLIENTE] msg 10');
});

test('sem histórico -> transcrição vazia', () => {
  assert.equal(montarTranscricao([], NOME_IA), '');
  assert.equal(montarTranscricao(null, NOME_IA), '');
});
