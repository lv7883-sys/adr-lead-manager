'use strict';
//
// sql-sem-crase.test.js — CRASE DENTRO DE TEMPLATE LITERAL DERRUBA O MÓDULO INTEIRO.
//
// Eu cometi este erro DUAS VEZES em 20/11/2026, no mesmo arquivo e no mesmo dia: de manhã,
// escrevendo um comentário SQL com `is_lead` entre crases; à tarde, com `ja_e_aluno` — depois
// de já ter escrito, de manhã, um comentário avisando para não fazer isso.
//
// A crase fecha o template literal: o arquivo deixa de ser JavaScript válido e o `require`
// estoura. Em produção isso não é um defeito de borda — é a Caixa de Entrada inteira fora do ar.
// As duas vezes quem pegou foi o teste, não a minha leitura.
//
// Aviso em comentário não impede repetição; este teste impede.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Arquivos que montam SQL em template literal e têm comentários longos dentro dele.
const ARQUIVOS = ['src/routes/inbox.js', 'src/stages.js', 'src/lifecycle.js', 'src/oportunidade.js'];

test('nenhum comentário SQL (-- ...) contém crase dentro de template literal', () => {
  for (const rel of ARQUIVOS) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const linhas = src.split('\n');
    const ruins = [];
    for (let i = 0; i < linhas.length; i++) {
      const l = linhas[i];
      // Só linhas que SÃO comentário SQL (começam com -- depois de espaços).
      if (!/^\s*--/.test(l)) continue;
      if (l.includes('`')) ruins.push(rel + ':' + (i + 1) + '  ' + l.trim().slice(0, 70));
    }
    assert.deepEqual(ruins, [], 'crase em comentário SQL quebra o template literal:\n' + ruins.join('\n'));
  }
});

test('os arquivos que montam SQL carregam de verdade', () => {
  // A prova final: se alguém fechar um template literal por acidente de outro jeito, o require
  // estoura aqui e não em produção.
  for (const rel of ARQUIVOS) {
    assert.doesNotThrow(() => require(path.join(__dirname, '..', rel)), rel + ' não carrega');
  }
});
