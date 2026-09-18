'use strict';
//
// experimentais-parser.test.js — parsers do adapter das aulas experimentais (migr 129).
//
// Fixtures: HTML REAL da Extranet (ago/2026), recortado e ANONIMIZADO — nome, telefone, e-mail e
// idade trocados por fictícios. A estrutura (tags, classes, selects, códigos de status) é a real.
//
// Rodar: node --test test/experimentais-parser.test.js
//
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseMes, parseDetalhe } = require('../src/cadastro/adapters/valinhos-experimentais');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');

test('parseMes: pega só aula EXPERIMENTAL, com id e rótulo', () => {
  const aulas = parseMes(fx('exp-mes.html'));
  assert.equal(aulas.length, 4, 'as 4 experimentais da fixture; a aula regular fica de fora');
  assert.ok(aulas.every((a) => /^\d+$/.test(a.aulaId)), 'todo item tem aula_id numérico');
  assert.ok(!aulas.some((a) => a.aulaId === '99999'), 'aula regular (sem a marca aulaexperimental) não entra');
});

test('parseMes: rótulo sai mesmo quando vem com o sufixo de REPOSIÇÃO', () => {
  // Bug da primeira versão: "Realizada - <i class='… aulareposicao'>" deixava o rótulo vazio (7 de 50
  // aulas em ago/2026). O rótulo é o que dispara a releitura quando a aula vira "com matrícula
  // posterior" — vazio para sempre, nunca releria.
  const aulas = parseMes(fx('exp-mes.html'));
  assert.ok(aulas.every((a) => a.rotulo && a.rotulo.length > 3), 'nenhum rótulo vazio: ' + JSON.stringify(aulas));
  const rotulos = aulas.map((a) => a.rotulo);
  assert.ok(rotulos.includes('Realizada com matrícula posterior'), 'decodifica o &iacute;');
  assert.ok(rotulos.some((r) => /^Cancelada pelo aluno$/.test(r)));
});

test('parseMes: id repetido na grade conta UMA vez', () => {
  const h = fx('exp-mes.html');
  assert.equal(parseMes(h + h).length, 4, 'a mesma aula duas vezes na página não duplica');
});

test('parseDetalhe: aula REALIZADA', () => {
  const d = parseDetalhe(fx('exp-det-realizada.html'));
  assert.equal(d.statusCod, 200);
  assert.equal(d.statusRotulo, 'Realizada');
  assert.equal(d.data, '2026-08-03');
  assert.equal(d.aluno, 'Aluno Ficticio');
  assert.equal(d.responsavel, 'Responsavel Ficticio');
  assert.equal(d.fone1, '(19)99999-0001');
  assert.equal(d.fone2, null, 'Telefone 2 vazio vira null, não string vazia');
  assert.equal(d.origem, 'WhatsApp');
  assert.ok(d.curso && d.professor, 'curso e professor');
});

test('parseDetalhe: o CÓDIGO distingue realizada com matrícula de cancelada', () => {
  assert.equal(parseDetalhe(fx('exp-det-convertida.html')).statusCod, 220, 'Realizada com matrícula posterior');
  assert.equal(parseDetalhe(fx('exp-det-cancelada.html')).statusCod, 310, 'Cancelada pelo aluno');
});

test('parseDetalhe: página que não é detalhe de aula devolve null (sessão caída, id errado)', () => {
  assert.equal(parseDetalhe('<html><form id="kc-form-login"></form></html>'), null);
  assert.equal(parseDetalhe(''), null);
});
