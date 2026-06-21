'use strict';
//
// Testes OFFLINE do onboarding Meta — máquina do `state` (HMAC/exp), allowlist de
// return_to e falha explícita de env. (E2E vivo: ver test/gate-onboarding-meta.js,
// que precisa de DB + app Meta + envs no container.)
//
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

// Envs necessárias ANTES de exercitar os caminhos que as exigem.
process.env.META_APP_SECRET = process.env.META_APP_SECRET || 'test-app-secret';
process.env.META_APP_ID = process.env.META_APP_ID || '123456';
process.env.META_LOGIN_CONFIG_ID = process.env.META_LOGIN_CONFIG_ID || 'cfg789';
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://leads-api.leovecchi.com';

const onb = require('../src/onboardingMeta');

// Replica a assinatura do state (mesmo algoritmo do módulo) p/ montar states válidos
// SEM nonce — assim verifyState não toca no redis (teste hermético).
const b64url = (buf) => Buffer.from(buf).toString('base64url');
function makeState(payload) {
  const pb = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', process.env.META_APP_SECRET).update(pb).digest());
  return pb + '.' + sig;
}

test('isAllowedReturnTo: só host na allowlist', () => {
  assert.equal(onb.isAllowedReturnTo('https://agenda.leovecchi.com/f/x/configuracoes'), true);
  assert.equal(onb.isAllowedReturnTo('https://evil.com/phish'), false);
  assert.equal(onb.isAllowedReturnTo('ftp://agenda.leovecchi.com'), false);
  assert.equal(onb.isAllowedReturnTo('not a url'), false);
});

test('returnToFromState: extrai return_to válido e rejeita host fora da allowlist', () => {
  const ok = makeState({ t: 'tid', e: Date.now() + 1000, r: 'https://agenda.leovecchi.com/f/x/configuracoes' });
  assert.equal(onb.returnToFromState(ok), 'https://agenda.leovecchi.com/f/x/configuracoes');
  const evil = makeState({ t: 'tid', e: Date.now() + 1000, r: 'https://evil.com' });
  assert.equal(onb.returnToFromState(evil), null);   // open-redirect bloqueado
});

test('verifyState: aceita state válido (sem nonce, não toca redis)', async () => {
  const exp = Date.now() + 60000;
  const state = makeState({ t: 'tenant-123', e: exp, r: 'https://agenda.leovecchi.com/back' });
  const out = await onb.verifyState(state);
  assert.equal(out.tenantId, 'tenant-123');
  assert.equal(out.returnTo, 'https://agenda.leovecchi.com/back');
});

test('verifyState: rejeita assinatura adulterada', async () => {
  const state = makeState({ t: 'tid', e: Date.now() + 60000 });
  const tampered = state.slice(0, -2) + (state.endsWith('aa') ? 'bb' : 'aa');
  await assert.rejects(() => onb.verifyState(tampered), /bad_state|assinatura/);
});

test('verifyState: rejeita state expirado', async () => {
  const state = makeState({ t: 'tid', e: Date.now() - 1000 });
  await assert.rejects(() => onb.verifyState(state), (e) => e.code === 'state_expired');
});

test('verifyState: rejeita state malformado', async () => {
  await assert.rejects(() => onb.verifyState('semponto'), (e) => e.code === 'bad_state');
});

test('buildStartUrl: falha EXPLÍCITA quando env obrigatória falta', async () => {
  const saved = process.env.META_APP_ID;
  delete process.env.META_APP_ID;
  try {
    await assert.rejects(
      () => onb.buildStartUrl({ tenantId: 'tid', returnTo: 'https://agenda.leovecchi.com/x' }),
      (e) => e.code === 'env_missing' && e.envName === 'META_APP_ID'
    );
  } finally {
    process.env.META_APP_ID = saved;
  }
});

test('buildStartUrl: rejeita return_to fora da allowlist', async () => {
  await assert.rejects(
    () => onb.buildStartUrl({ tenantId: 'tid', returnTo: 'https://evil.com/x' }),
    (e) => e.code === 'bad_return_to'
  );
});
