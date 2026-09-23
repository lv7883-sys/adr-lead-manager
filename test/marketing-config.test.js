'use strict';
// marketing-config.test.js — a validação PURA da tela de configuração da captura, offline.
//
// O que se decide aqui é quem pode virar fonte de mídia. Um erro nesta função não dá erro
// em lugar nenhum: faz o sistema passar a capturar de uma conversa de cliente.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const rotas = require('../src/routes/marketing');

test('só grupo do WhatsApp vira fonte — telefone de cliente NUNCA', () => {
  assert.equal(rotas._jidDeGrupo('120363224711320694@g.us'), '120363224711320694@g.us');
  assert.equal(rotas._jidDeGrupo('  120363224711320694@g.us  '), '120363224711320694@g.us',
    'espaço colado no copiar-e-colar não pode recusar um grupo válido');

  // O caso que a trava existe para impedir: conversa 1:1 cadastrada como fonte faria a
  // captura recolher foto que um cliente mandou para a recepção.
  assert.equal(rotas._jidDeGrupo('5519999990001@s.whatsapp.net'), null, 'telefone não é grupo');
  assert.equal(rotas._jidDeGrupo('5519999990001'), null, 'dígitos soltos não são grupo');
  assert.equal(rotas._jidDeGrupo('274312345678901@lid'), null, 'identificador de privacidade não é grupo');
});

test('lixo e tentativa de contrabando não passam', () => {
  for (const ruim of [null, undefined, '', '   ', '@g.us', 'abc@g.us', 'nenhum',
    "120363224711320694@g.us'; DROP TABLE marketing.grupo_fonte; --",
    '120363224711320694@g.us extra', '../120363224711320694@g.us']) {
    assert.equal(rotas._jidDeGrupo(ruim), null, `deveria recusar: ${JSON.stringify(ruim)}`);
  }
});

test('o limite de grupos por unidade existe e é um número', () => {
  // Não é trava de segurança, é de sanidade: 20 grupos-fonte numa escola é engano de
  // cadastro, e engano de cadastro vira conta de armazenamento no fim do mês.
  assert.ok(Number.isInteger(rotas.MAX_GRUPOS) && rotas.MAX_GRUPOS > 0);
});
