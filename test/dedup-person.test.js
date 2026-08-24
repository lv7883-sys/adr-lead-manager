'use strict';
// dedup-person.test.js — lógica PURA da fusão de person duplicada (sem DB). Cobre a classificação
// DUPLICATA vs HOMÔNIMO, a inclusão por telefone quando falta nascimento, e a escolha do sobrevivente.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normNome, escolherSobrevivente, classificarGrupo, montarGrupos,
} = require('../src/cadastro/dedup-person');

const P = (over = {}) => ({
  id: over.id || 'p', display_name: 'x', dob: null, payer_relation: null,
  created_at: '2026-01-01T00:00:00Z', aluno_ids: [], phones: [], contratos: 0, ...over });

test('normNome: tira acento, caixa e pontuação; espaço único', () => {
  assert.equal(normNome('  Diógenes  Favareto Júnior '), 'diogenes favareto junior');
  assert.equal(normNome('João-Lucas  Guardia'), 'joao lucas guardia');
  assert.equal(normNome('MELANIE KREBS'), normNome('melanie krebs'));
});

test('DUPLICATA: mesmo nascimento → todos fundíveis', () => {
  const g = classificarGrupo([
    P({ id: 'a', dob: '2010-05-05' }), P({ id: 'b', dob: '2010-05-05' })]);
  assert.equal(g.tipo, 'DUPLICATA');
  assert.equal(g.mergeable.length, 2);
  assert.equal(g.ambiguos.length, 0);
});

test('HOMÔNIMO: nascimentos diferentes → nada funde', () => {
  const g = classificarGrupo([
    P({ id: 'a', dob: '2010-05-05' }), P({ id: 'b', dob: '1988-01-02' })]);
  assert.equal(g.tipo, 'HOMONIMO');
  assert.equal(g.mergeable.length, 0);
});

test('nasc ausente + telefone casa → entra na fusão (caso órfão só-telefone do Enzo)', () => {
  const g = classificarGrupo([
    P({ id: 'a', dob: '2012-03-03', phones: ['5519999998888'] }),
    P({ id: 'orfao', dob: null, phones: ['19999998888'] })]);  // últimos-8 batem
  assert.equal(g.tipo, 'DUPLICATA');
  assert.deepEqual(g.mergeable.map((p) => p.id).sort(), ['a', 'orfao']);
  assert.equal(g.ambiguos.length, 0);
});

test('nasc ausente e telefone NÃO casa → ambíguo, fora da fusão', () => {
  const g = classificarGrupo([
    P({ id: 'a', dob: '2012-03-03', phones: ['5519111112222'] }),
    P({ id: 'b', dob: null, phones: ['5519333334444'] })]);
  assert.equal(g.tipo, 'DUPLICATA');
  assert.deepEqual(g.mergeable.map((p) => p.id), ['a']);
  assert.deepEqual(g.ambiguos.map((p) => p.id), ['b']);
});

test('sobrevivente: mais contratos > mais completo > mais antigo', () => {
  const s1 = escolherSobrevivente([
    P({ id: 'poucos', contratos: 1 }), P({ id: 'muitos', contratos: 3 })]);
  assert.equal(s1.id, 'muitos');
  const s2 = escolherSobrevivente([
    P({ id: 'magro', contratos: 2, dob: null, phones: [] }),
    P({ id: 'gordo', contratos: 2, dob: '2010-01-01', payer_relation: 'self_paid', phones: ['x'] })]);
  assert.equal(s2.id, 'gordo');
  const s3 = escolherSobrevivente([
    P({ id: 'novo', contratos: 1, created_at: '2026-06-01T00:00:00Z' }),
    P({ id: 'velho', contratos: 1, created_at: '2025-01-01T00:00:00Z' })]);
  assert.equal(s3.id, 'velho');
});

test('montarGrupos: agrupa por nome-norm, ignora nomes únicos, marca sobrevivente/perdedores', () => {
  const grupos = montarGrupos([
    P({ id: 'a1', display_name: 'Melanie Krebs', dob: '2011-02-02', contratos: 2 }),
    P({ id: 'a2', display_name: 'melanie  krebs', dob: '2011-02-02', contratos: 1 }),
    P({ id: 'solo', display_name: 'Fulano Único', dob: '2000-01-01' }),
    P({ id: 'h1', display_name: 'Rafael Serrão', dob: '2010-01-01' }),
    P({ id: 'h2', display_name: 'rafael serrao', dob: '1990-01-01' })]);
  const mela = grupos.find((g) => g.nomeNorm === 'melanie krebs');
  assert.equal(mela.tipo, 'DUPLICATA');
  assert.equal(mela.survivor.id, 'a1');            // 2 contratos > 1
  assert.deepEqual(mela.losers.map((p) => p.id), ['a2']);
  const rafa = grupos.find((g) => g.nomeNorm === 'rafael serrao');
  assert.equal(rafa.tipo, 'HOMONIMO');
  assert.equal(rafa.survivor, null);
  assert.equal(grupos.some((g) => g.nomeNorm === 'fulano unico'), false);  // único não vira grupo
});
