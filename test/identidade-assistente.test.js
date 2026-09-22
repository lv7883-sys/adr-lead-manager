'use strict';
//
// identidade-assistente.test.js — a assistente NUNCA se apresenta com nome de gente da equipe.
//
// O CASO (22/09/2026): a recepção viu a IA se apresentando como uma recepcionista real. Eram 45
// mensagens em 30 dias e 5 rascunhos esperando aprovação. A raiz estava no prompt salvo da unidade,
// que MANDAVA se apresentar assim ("Na primeira mensagem… 'Aqui é a Fulana da Escola X'"), e a trava
// de identidade que já existia só cobria o envio automático — o rascunho que a recepção aprova passava.
//
// MULTI-TENANT: o único nome aceito é o que a unidade configurou (automacao_config.nome_ia). Nome de
// produto chumbado no código é proibido — inclusive "Janis", que é o nome que UMA unidade escolheu.
//
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sanitizarIdentidade, nomeUsavel } = require('../src/temaProibido');
const { blocoPerfil } = require('../src/perfilAssistente');
const { resolveSystemPrompt } = require('../src/templates');

const NOME = 'Janis J. (assistente virtual)';

test('apresentação com nome de recepcionista vira o nome configurado da unidade', () => {
  const r = sanitizarIdentidade('Olá! Boa tarde. Aqui é a Késsia da Academia do Rock Valinhos. Vimos seu interesse.', { nomeIa: NOME });
  assert.match(r.texto, /Aqui é a Janis J\. da Academia do Rock Valinhos/);
  assert.doesNotMatch(r.texto, /Késsia/);
  assert.deepEqual(r.trocas, ['Aqui é a Késsia'], 'registra o que foi trocado (vai para o log)');
  // "(assistente virtual)" fica fora do meio da frase
  assert.equal(nomeUsavel(NOME), 'Janis J.');
});

test('outras formas de se apresentar também são pegas', () => {
  for (const frase of ['Sou a Rafa, da escola', 'Eu sou o Pedro do atendimento', 'Meu nome é Carla e vou te ajudar']) {
    const r = sanitizarIdentidade(frase, { nomeIa: 'Ana' });
    assert.equal(r.trocas.length, 1, frase);
    assert.match(r.texto, /Ana/);
  }
});

test('assinatura em negrito de outra pessoa vira a da assistente', () => {
  const r = sanitizarIdentidade('*Késsia*\nOi! Segue o combinado.', { nomeIa: NOME });
  assert.match(r.texto, /^\*Janis J\.\*/);
  assert.deepEqual(r.trocas, ['*Késsia*']);
});

test('não mexe no que está certo: o próprio nome, "assistente", texto sem apresentação', () => {
  for (const frase of ['Aqui é a Janis J. da escola!', 'Sou a assistente virtual da escola', 'Bom dia! Como posso ajudar?', '*Janis J.*\nOi!']) {
    assert.deepEqual(sanitizarIdentidade(frase, { nomeIa: NOME }).trocas, [], frase);
  }
});

test('unidade SEM nome configurado: a apresentação pessoal sai do texto (não inventa nome)', () => {
  const r = sanitizarIdentidade('Olá! Aqui é a Késsia da escola. Tudo bem?', { nomeIa: '' });
  assert.doesNotMatch(r.texto, /Késsia|Janis/);
  assert.match(r.texto, /da escola/);
  assert.equal(r.trocas.length, 1);
});

test('o prompt diz o nome da unidade e proíbe outro — e não afirma nada quando o perfil não foi carregado', () => {
  assert.match(blocoPerfil({ nome_ia: 'Ana Clara' }), /SEU NOME: Ana Clara\.[\s\S]*NUNCA use o nome de uma pessoa da equipe/);
  assert.match(blocoPerfil({}), /NÃO TEM NOME PRÓPRIO configurado/);
  assert.equal(blocoPerfil(null), '', 'perfil ausente ≠ unidade sem nome');
  // vem DEPOIS do prompt da unidade: é a última instrução sobre nome
  const p = resolveSystemPrompt({ system_prompt_override: 'Você é a Fulana, recepcionista.', perfil: { nome_ia: 'Ana Clara' } });
  assert.ok(p.indexOf('Você é a Fulana') < p.indexOf('SEU NOME: Ana Clara'));
});

test('nenhum nome de assistente chumbado no código do Lead Manager', () => {
  const raiz = path.join(__dirname, '..', 'src');
  const arquivos = [];
  (function varrer(dir) {
    for (const nome of fs.readdirSync(dir)) {
      const p = path.join(dir, nome);
      if (fs.statSync(p).isDirectory()) varrer(p);
      else if (nome.endsWith('.js')) arquivos.push(p);
    }
  })(raiz);
  // só CÓDIGO: comentário citando "a Janis" (a assistente de Valinhos) é documentação, não comportamento
  const ehComentario = (linha) => /^\s*(\/\/|\*|\/\*)/.test(linha);
  const comNome = arquivos.filter((f) => fs.readFileSync(f, 'utf8')
    .split('\n').filter((l) => !ehComentario(l))
    .some((l) => /['"`]Janis['"`]/.test(l)));
  assert.deepEqual(comNome, [], 'o nome da assistente é de cada unidade (automacao_config.nome_ia)');
});
