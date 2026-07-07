'use strict';

// ============================================================================
// Camada 1 (ADR-003 Emenda E1) — conserto do match de telefone em
// _isRelationshipContact: igualdade EXATA de dígitos → match BR-aware (matchKeys).
//
// Este teste NÃO toca no banco. Ele reproduz EXATAMENTE a comparação que a query
// corrigida faz — `normalize(prof.telefone) = ANY(matchKeys(identDigits))` — usando
// o MESMO helper (src/telefoneBR.js:matchKeys) e a MESMA normalização de dígitos
// (regexp_replace('[^0-9]','') ≡ String.replace(/\D/g,'')). Fixtures = dados reais
// (Valinhos, 2026-07-07): os 22 pares lead↔professor que vazaram e uma amostra de
// leads reais que NÃO são professores (prova de ausência de falso positivo).
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const telBR = require('../src/telefoneBR');

// --- Fixture: app.professor_notificacao (42 cadastros), já normalizados p/ dígitos.
// Vários guardam SEM o DDI 55 (ex.: 19994301015) — a raiz do bug.
const PROFESSORES = [
  '11954793565', '11974289108', '11980323913', '17981125567', '18997670664',
  '19920001607', '19971062615', '19978170165', '19981161004', '19981502848',
  '19981671797', '19982202654', '19983295928', '19988984012', '19989526116',
  '19991070737', '19991637713', '19992183507', '19992567532', '19993696165',
  '19994301015', '19994650543', '19995394897', '19995553513', '19996038905',
  '19996942711', '19997141684', '19997276345', '19997615601', '19997968212',
  '19998407298', '19998563588', '19998724652', '19999416165', '19999595912',
  '41992724515', '42998201080', '5511948289193', '5519982138919', '5519996673013',
  '5541999511313', '559885548478',
];
const PROF_SET = new Set(PROFESSORES);

// --- Fixture: os 22 pares lead↔professor que vazaram (lead chega com DDI 55).
const PARES = [
  ['+5519997615601', 'Allan Azevedo'],
  ['+5519996038905', 'Augusto Asciutti'],
  ['+5519994650543', 'Cesito Haddad'],
  ['+5519981502848', 'Cláudio'],
  ['+5519996673013', 'Denise'],
  ['+5519998563588', 'Fabiano'],
  ['+5519998724652', 'Fábio Vieira'],
  ['+5519994301015', 'Giovanni Moura'],
  ['+5519981671797', 'Hicaro'],
  ['+5519995394897', 'Isabella Conte'],
  ['+5519992183507', 'Juliano'],
  ['+554199511313', 'Leo Vecchi'],
  ['+5519999595912', 'Luis Yamashita'],
  ['+5519992567532', 'Patrícia Bissoto'],
  ['+5519971062615', 'Paula Ramos'],
  ['+5519978170165', 'Ricardo Magalhães'],
  ['+5519988984012', 'Rafa Squizatto'],
  ['+5519997968212', 'Tom'],
  ['+554192724515', 'Vecchi'],
  ['+5517981125567', 'Vinícius Arães'],
  ['+5519999416165', 'Vitor Mendes'],
  ['+5511980323913', 'Wagner Mesquita'],
];

// --- Fixture: leads reais que NÃO são professores (amostra). Nenhum pode casar.
const NAO_PROFESSORES = [
  '+5519999803004', '+5519994842840', '+5519991248240', '+5511998847549',
  '+5519994176251', '+5519989858228', '+5519998367576', '+5519996928888',
  '+5519992323460', '+5519996190201', '+5519982108986', '+5519991366098',
  '+5519994166886', '+5519997476776', '+5519983290398', '+5519991472382',
  '+5511942008184', '+5511979753819', '+5519983387497', '+5511983461913',
];

// Réplica FIEL da query corrigida de _isRelationshipContact:
//   SELECT 1 ... WHERE normalize(telefone) = ANY(matchKeys(identDigits))
// O caller passa identDigits = String(phone).replace(/\D/g,''); matchKeys re-strip é no-op.
function isRelationshipContact(rawPhone) {
  const identDigits = String(rawPhone || '').replace(/\D/g, '');
  const keys = telBR.matchKeys(identDigits);
  if (!keys.length) return false;
  return PROFESSORES.some((profDigits) => keys.includes(profDigits));
}

// Comportamento ANTIGO (igualdade exata) — só p/ documentar a regressão que fechamos.
function isRelationshipContactExato(rawPhone) {
  const identDigits = String(rawPhone || '').replace(/\D/g, '');
  return PROF_SET.has(identDigits);
}

test('Camada 1: os 22 professores que vazavam agora CASAM (matchKeys=22, NO_MATCH=0)', () => {
  let match = 0;
  let noMatch = 0;
  const escaparam = [];
  for (const [phone, nome] of PARES) {
    if (isRelationshipContact(phone)) match += 1;
    else { noMatch += 1; escaparam.push(`${nome} (${phone})`); }
  }
  assert.equal(match, 22, `esperava 22 casando; escaparam: ${escaparam.join(', ')}`);
  assert.equal(noMatch, 0, `esperava 0 sem match; escaparam: ${escaparam.join(', ')}`);
  assert.equal(PARES.length, 22, 'a amostra deve ter os 22 pares');
});

test('Regressão: a igualdade EXATA (comportamento antigo) só pegava 1/22', () => {
  const exato = PARES.filter(([phone]) => isRelationshipContactExato(phone)).length;
  // Só "Denise" tinha o cadastro já com 55 (5519996673013); os outros 21 vazavam.
  assert.equal(exato, 1, 'a igualdade exata casava apenas 1 dos 22 (Denise)');
});

test('Sem falso positivo: leads reais que NÃO são professores continuam NÃO casando', () => {
  const falsosPositivos = NAO_PROFESSORES.filter((phone) => isRelationshipContact(phone));
  assert.deepEqual(
    falsosPositivos, [],
    `nenhum não-professor pode casar; casaram por engano: ${falsosPositivos.join(', ')}`
  );
});

test('Sanidade do fixture: matchKeys de um lead com 55 gera a variante sem 55 do cadastro', () => {
  // Giovanni: lead 5519994301015 (com 55) precisa gerar 19994301015 (como está no cadastro).
  const keys = telBR.matchKeys('5519994301015');
  assert.ok(keys.includes('19994301015'), 'matchKeys deve conter a forma sem 55 do cadastro');
});
