'use strict';
// linkPreview.test.js — o 1º link sem esquema ganha https:// para virar caixinha no WhatsApp.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { comEsquema } = require('../src/linkPreview');

test('link sem esquema ganha https:// (só o primeiro)', () => {
  assert.equal(comEsquema('Pague aqui: www.mercadopago.com.br/abc'), 'Pague aqui: https://www.mercadopago.com.br/abc');
  assert.equal(comEsquema('link mpago.la/2xYz e outro site.com'), 'link https://mpago.la/2xYz e outro site.com');
  assert.equal(comEsquema('agenda.leovecchi.com/l/x8wfrme'), 'https://agenda.leovecchi.com/l/x8wfrme');
  assert.equal(comEsquema('Veja (academiadorock.com.br).'), 'Veja (https://academiadorock.com.br).');
});

test('não mexe no que não deve', () => {
  assert.equal(comEsquema('já tem https://x.com e y.com'), 'já tem https://x.com e y.com');
  assert.equal(comEsquema('email: maria@gmail.com'), 'email: maria@gmail.com');
  assert.equal(comEsquema('http://site-antigo.com'), 'http://site-antigo.com');
  assert.equal(comEsquema('Obs.: aula às 17h. Até amanhã'), 'Obs.: aula às 17h. Até amanhã');
  assert.equal(comEsquema('R$ 250.00 no total'), 'R$ 250.00 no total');
  assert.equal(comEsquema(''), '');
});
