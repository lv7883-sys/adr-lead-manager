'use strict';
//
// templates-cursos.test.js — a lista de CURSOS E AULAS da unidade chega em toda resposta da assistente.
//
// Caso real (16/09/2026): Valinhos passou a ter violino e gaita. A lista existia no banco
// (tenant_lead_config.available_instruments), mas só entrava no template PADRÃO — e a unidade usa um
// prompt próprio (override). Resultado: sugestão, estratégia e retomada nunca viam a lista.
//
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSystemPrompt, normalizarCursos, blocoCursos } = require('../src/templates');

test('override da unidade + cursos configurados -> a lista vai junto', () => {
  const sp = resolveSystemPrompt({ system_prompt_override: 'Você atende a escola.', available_instruments: ['Violino', 'Gaita'] });
  assert.ok(sp.startsWith('Você atende a escola.'), 'o texto da unidade fica intacto');
  assert.match(sp, /O QUE A EMPRESA OFERECE[^:]*: Violino, Gaita\./);
  assert.match(sp, /NÃO está na lista, não afirme que tem nem que não tem/);
});

test('sem lista -> o override sai exatamente como a unidade escreveu', () => {
  assert.equal(resolveSystemPrompt({ system_prompt_override: 'X', available_instruments: [] }), 'X');
  assert.equal(resolveSystemPrompt({ system_prompt_override: 'X' }), 'X');
});

test('template padrão também recebe o bloco, sem repetir a lista em outro lugar', () => {
  const sp = resolveSystemPrompt({ system_prompt_override: null, school_name: 'Escola Y', available_instruments: ['Piano'] });
  assert.equal((sp.match(/Piano/g) || []).length, 1);
  assert.match(sp, /Escola Y/);
});

test('normaliza: espaços, vazios, repetidos (com e sem acento) e tamanho', () => {
  assert.deepEqual(normalizarCursos(['  Violão ', 'violao', 'Gaita', '', null, 'Canto  coral', 'GAITA']), ['Violão', 'Gaita', 'Canto coral']);
  assert.deepEqual(normalizarCursos('Violino'), [], 'só aceita lista');
  assert.equal(normalizarCursos(Array.from({ length: 80 }, (_, i) => `Curso ${i}`)).length, 60);
  assert.equal(normalizarCursos(['x'.repeat(100)])[0].length, 60);
  assert.equal(blocoCursos({ available_instruments: [] }), '');
});
