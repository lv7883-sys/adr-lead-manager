'use strict';
//
// Lead que a RECEPÇÃO digita (02/11/2026). Testes PUROS, sem banco.
//
// O que eles cobrem: a decisão de o que é um lead válido, a normalização do telefone pela régua
// do projeto, e as RECUSAS. O que eles NÃO cobrem, dito para não ser confundido com cobertura:
// a dedupe por telefone e o INSERT moram na rota (`routes/tenant.js`) e precisam de banco —
// estão fora daqui.
//
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepararLeadManual, ORIGENS_ACEITAS, ORIGEM_PADRAO, MAX_NOME, MIN_DIGITOS, MAX_DIGITOS } = require('../src/leadManual');
const { digitsBR } = require('../src/telefoneBR');

test('anota o contato com nome e telefone, e normaliza os dois', () => {
  const r = prepararLeadManual({ nome: '  Marina   Alvares  ', telefone: '(19) 99000-0001' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.lead, {
    name: 'Marina Alvares',          // espaços colapsados e aparados
    phone: '5519990000001',          // dígitos com DDI, sem "+", como o webhook grava
    status: 'NEW',                   // a coluna "Novo": intake, nunca destino de arraste
    origem: 'manual',
  });
});

test('o telefone sai pela MESMA régua do resto do sistema, não por uma segunda', () => {
  // Se esta igualdade quebrar, o lead digitado deixa de casar com a conversa quando a pessoa
  // escrever — e o sintoma seria um lead parado em "Novo" para sempre, sem erro nenhum.
  for (const cru of ['19990000001', '(19) 99000-0001', '+55 19 99000-0001', '5519990000001']) {
    assert.equal(prepararLeadManual({ nome: 'X', telefone: cru }).lead.phone, digitsBR(cru),
      `${cru} não saiu pela régua de telefoneBR`);
  }
});

test('o nome é obrigatório — a coluna é NOT NULL e é o que aparece no card', () => {
  for (const nome of ['', '   ', null, undefined, 42]) {
    const r = prepararLeadManual({ nome, telefone: '19990000001' });
    assert.equal(r.ok, false);
    assert.equal(r.erro, 'nome_obrigatorio');
  }
});

test('telefone curto e telefone longo demais são RECUSADOS, com o motivo no detalhe', () => {
  const curto = prepararLeadManual({ nome: 'X', telefone: '1234567' });
  assert.equal(curto.erro, 'telefone_invalido');
  assert.match(curto.detalhe, new RegExp(`mínimo é ${MIN_DIGITOS}`));

  // Mais de 15 dígitos não é telefone: costuma ser id de grupo do WhatsApp ou @lid colado por
  // engano. Recusar evita um lead que nunca casaria com ninguém — o "zero silencioso" de sempre.
  const longo = prepararLeadManual({ nome: 'X', telefone: '120363099999999999' });
  assert.equal(longo.erro, 'telefone_invalido');
  assert.match(longo.detalhe, new RegExp(`máximo \\(E.164\\) é ${MAX_DIGITOS}`));
});

test('a origem é uma lista fechada — texto livre viraria pó de categoria na métrica de fonte', () => {
  assert.ok(ORIGENS_ACEITAS.includes(ORIGEM_PADRAO));
  for (const o of ORIGENS_ACEITAS) {
    assert.equal(prepararLeadManual({ nome: 'X', telefone: '19990000001', origem: o }).lead.origem, o);
  }
  // maiúscula e espaço não criam categoria nova
  assert.equal(prepararLeadManual({ nome: 'X', telefone: '19990000001', origem: ' Indicacao ' }).lead.origem, 'indicacao');
  const mau = prepararLeadManual({ nome: 'X', telefone: '19990000001', origem: 'tiktok' });
  assert.equal(mau.erro, 'origem_invalida');
  assert.match(mau.detalhe, /Use uma de:/);
});

test('sem origem declarada, fica `manual` — que é o PRIMEIRO TOQUE de verdade', () => {
  // migr 043 travou: origem é gravada uma vez na criação e NUNCA alterada. Quem digitou o contato
  // na recepção FOI o primeiro toque, mesmo que a pessoa escreva pelo WhatsApp depois.
  assert.equal(prepararLeadManual({ nome: 'X', telefone: '19990000001' }).lead.origem, 'manual');
  assert.equal(prepararLeadManual({ nome: 'X', telefone: '19990000001', origem: '' }).lead.origem, 'manual');
});

test('nome gigante é cortado, não recusado — quem digitou não deve perder o trabalho', () => {
  const r = prepararLeadManual({ nome: 'a'.repeat(MAX_NOME + 50), telefone: '19990000001' });
  assert.equal(r.ok, true);
  assert.equal(r.lead.name.length, MAX_NOME);
});

test('entrada vazia ou lixo não explode — devolve recusa, não exceção', () => {
  for (const e of [undefined, null, {}, { nome: {}, telefone: [] }, 'texto']) {
    const r = prepararLeadManual(e);
    assert.equal(r.ok, false, `${JSON.stringify(e)} deveria ser recusado`);
    assert.ok(typeof r.erro === 'string' && r.erro.length > 0);
  }
});

test('o status nasce em NEW — e isso importa para a tela', () => {
  // 'NEW' é a coluna "Novo" do kanban, marcada na régua como `auto: true`: origem de tudo, nunca
  // destino de arraste. Um contato recém-anotado pertence ali, e não no meio do funil.
  const stages = require('../src/stages');
  const r = prepararLeadManual({ nome: 'X', telefone: '19990000001' });
  assert.equal(r.lead.status, 'NEW');
  assert.equal(stages.stageOfLead({ status: r.lead.status }), 'novo');
  assert.equal(stages.KANBAN_STAGES.find((s) => s.key === 'novo').auto, true);
});
