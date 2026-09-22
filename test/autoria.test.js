'use strict';
// Autoria real (by_name → review_by): teste PURO da sanitização em src/autoria.js.
// O que protege: cada nome próprio novo ATIVA o latch humano do contractConvert
// (`review_by <> 'SERVICE'`), então um by_name forjado com valor reservado fabricaria
// um "humano" (ou uma "máquina") falso e envenenaria a distinção pessoa × serviço ×
// automação. Reservado ou vazio → cai no papel do token, como se o campo não viesse.
const { test } = require('node:test');
const assert = require('node:assert');
const { autorHumano } = require('../src/autoria.js');

const req = (by_name) => ({ body: { by_name }, tenantRole: 'SERVICE' });

test('nome próprio passa e vira o autor (ativa o latch humano)', () => {
  assert.equal(autorHumano(req('Rafaela')), 'Rafaela');
  assert.equal(autorHumano(req('  Camila Santana  ')), 'Camila Santana');
  assert.equal(autorHumano(req('humano sem nome (recepcionista)')), 'humano sem nome (recepcionista)');
});

test('campo ausente, vazio ou não-string cai no papel do token', () => {
  assert.equal(autorHumano({ body: {}, tenantRole: 'SERVICE' }), 'SERVICE');
  assert.equal(autorHumano({ tenantRole: 'SERVICE' }), 'SERVICE');
  assert.equal(autorHumano(req('')), 'SERVICE');
  assert.equal(autorHumano(req('   ')), 'SERVICE');
  assert.equal(autorHumano(req(42)), 'SERVICE');
});

test('valores reservados não fabricam humano nem máquina', () => {
  for (const v of ['SERVICE', 'service', 'Service', 'ia_auto', 'IA_AUTO', 'extranet_auto',
    'contrato_auto', 'migracao-127', 'MIGRACAO-128', 'migracao-qualquer']) {
    assert.equal(autorHumano(req(v)), 'SERVICE', `reservado vazou: ${v}`);
  }
});

test('reservado só casa o valor inteiro — nome que o contém passa', () => {
  assert.equal(autorHumano(req('Serviceira da Silva')), 'Serviceira da Silva');
});

test('teto de 80 caracteres', () => {
  const grande = 'a'.repeat(200);
  assert.equal(autorHumano(req(grande)).length, 80);
});
