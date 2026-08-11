'use strict';
// extranet-leads-parser.test.js — PARSER PURO da lista de leads da Extranet (valinhos-leads).
// Roda sobre a fixture ANONIMIZADA (estrutura real do probe 2026-08-11). Sem PG, sem rede.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseLista } = require('../src/cadastro/adapters/valinhos-leads');
const { mapSituacao } = require('../src/cadastro/extranetLeadStage');

const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'extranet-leads-lista.html'), 'utf8');

test('parseLista extrai todas as linhas com id', () => {
  const rows = parseLista(html);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r.extranetId), ['9001', '9002', '9003', '9004', '9005']);
});

test('linha completa: nome, fone VISÍVEL (não o do href), curso/professor com entidades, datas', () => {
  const r = parseLista(html)[0];
  assert.equal(r.nome, 'Fulana Teste Um');
  assert.equal(r.foneRaw, '(41)9951-0001');            // texto visível; href tem DDD 0-prefixado
  assert.equal(r.curso, 'Canto - Técnica Vocal');       // &eacute; decodificado
  assert.equal(r.professor, 'Professora Teste');
  assert.equal(r.situacao, 'Exp. Agendada');
  assert.equal(r.dataCadastro, '2026-08-15T15:36:00-03:00');
  assert.equal(r.ultContato, '2026-08-10');
  assert.equal(r.proxContato, '2026-08-16');
});

test('linha sem curso/professor e badge com entidade (Conexão)', () => {
  const r = parseLista(html)[1];
  assert.equal(r.curso, 'Bateria');
  assert.equal(r.professor, null);
  assert.equal(r.situacao, 'Conexão');
  assert.equal(r.proxContato, null);
});

test('linha SEM telefone → foneRaw null (mirror-only no sync)', () => {
  const r = parseLista(html)[2];
  assert.equal(r.nome, 'Cicrana Sem Fone');
  assert.equal(r.foneRaw, null);
});

test('todas as situações da fixture mapeiam como esperado (conjunto real do statusA)', () => {
  const rows = parseLista(html);
  assert.deepEqual(rows.map((r) => mapSituacao(r.situacao)), [
    { key: 'experimental', known: true },   // Exp. Agendada
    { key: 'qualificando', known: true },   // Conexão
    { key: 'qualificando', known: true },   // Conexão
    { key: 'convertido', known: true },     // Ganhou (matrícula)
    { key: null, known: true },             // Exp. Cancelada → mirror-only
  ]);
});
