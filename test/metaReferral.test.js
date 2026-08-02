'use strict';
// metaReferral.test.js — extractReferral: parsing puro do objeto referral (Click-to-Message).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractReferral } = require('../src/metaReferral');

const AD = { ref: 'campanha_violao_ago', ad_id: '120210000000000001', source: 'ADS', type: 'OPEN_THREAD',
             ads_context_data: { ad_title: 'Aulas de violão', photo_url: 'https://x/y.jpg', post_id: '123_456' } };

test('(1) referral direto (usuário existente clicou o anúncio)', () => {
  const r = extractReferral({ sender: { id: 'PSID' }, referral: AD, message: { text: 'oi', mid: 'M1' } });
  assert.equal(r.adId, AD.ad_id);
  assert.equal(r.ref, AD.ref);
  assert.equal(r.source, 'ADS');
  assert.equal(r.type, 'OPEN_THREAD');
  assert.equal(r.adsContext.ad_title, 'Aulas de violão');
});

test('(2) referral no postback (usuário novo via "Começar")', () => {
  const r = extractReferral({ sender: { id: 'PSID' }, postback: { title: 'Começar', payload: 'GET_STARTED', referral: AD } });
  assert.equal(r.adId, AD.ad_id);
  assert.equal(r.ref, AD.ref);
});

test('(3) referral anexado à mensagem', () => {
  const r = extractReferral({ sender: { id: 'PSID' }, message: { text: 'oi', mid: 'M1', referral: AD } });
  assert.equal(r.adId, AD.ad_id);
});

test('(4) DM orgânico (sem anúncio) -> null', () => {
  assert.equal(extractReferral({ sender: { id: 'PSID' }, message: { text: 'oi', mid: 'M1' } }), null);
});

test('(5) referral sem ad_id e sem ref -> null (nada a atribuir)', () => {
  assert.equal(extractReferral({ sender: { id: 'PSID' }, referral: { source: 'SHORTLINK', type: 'OPEN_THREAD' } }), null);
});

test('(6) só ref, sem ad_id (link com ref) -> atribui pelo ref', () => {
  const r = extractReferral({ sender: { id: 'PSID' }, referral: { ref: 'promo_dia_das_maes', source: 'SHORTLINK' } });
  assert.equal(r.ref, 'promo_dia_das_maes');
  assert.equal(r.adId, null);
});

test('(7) precedência: m.referral vence postback/message', () => {
  const r = extractReferral({ sender: { id: 'PSID' }, referral: { ad_id: 'A', ref: 'top' },
                              postback: { referral: { ad_id: 'B', ref: 'baixo' } } });
  assert.equal(r.adId, 'A');
  assert.equal(r.ref, 'top');
});

test('(8) evento vazio / sem sender -> null', () => {
  assert.equal(extractReferral(null), null);
  assert.equal(extractReferral({}), null);
});
