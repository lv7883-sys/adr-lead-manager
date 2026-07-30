'use strict';
// meta-connect-token.test.js — conectar Meta por TOKEN de System User (reusa resolve/persist/
// subscribe). Deps mockadas: sem Graph, sem DB. Cobre happy-path + token curto + status assinado.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const onb = require('../src/onboardingMeta');

function mkDeps(overrides = {}) {
  const calls = { persist: null, subscribed: null };
  const deps = {
    resolveGrantedPage: async (tok) => { calls.token = tok; return { pageId: 'PID', pageName: 'ADR Valinhos', pageToken: 'PAGE_TOK', igId: 'IG123' }; },
    persistConnection: async (a) => { calls.persist = a; },
    subscribeLeadgen: async (pid) => { calls.subscribed = pid; },
    listSubscribedFields: async () => new Set(['leadgen', 'messages', 'messaging_postbacks']),
    ...overrides,
  };
  return { deps, calls };
}

test('(1) happy-path: resolve → persist → subscribe; retorna messages=true', async () => {
  const { deps, calls } = mkDeps();
  const out = await onb.connectByToken('T1', '  EAAtoken_de_system_user_bem_longo  ', deps);
  assert.equal(out.pageId, 'PID'); assert.equal(out.pageName, 'ADR Valinhos'); assert.equal(out.igId, 'IG123');
  assert.equal(out.subscribed.messages, true); assert.equal(out.subscribed.leadgen, true);
  assert.equal(calls.token, 'EAAtoken_de_system_user_bem_longo', 'token trimado');
  assert.deepEqual(calls.persist, { tenantId: 'T1', pageId: 'PID', pageToken: 'PAGE_TOK', igId: 'IG123' });
  assert.equal(calls.subscribed, 'PID');
});

test('(2) token curto/vazio -> lança bad_token (não chama resolve)', async () => {
  let resolved = false;
  const { deps } = mkDeps({ resolveGrantedPage: async () => { resolved = true; return {}; } });
  await assert.rejects(() => onb.connectByToken('T1', 'curto', deps), (e) => e.code === 'bad_token');
  assert.equal(resolved, false);
});

test('(3) subscribe falha -> não derruba; messages=false, mas persiste', async () => {
  const { deps, calls } = mkDeps({ subscribeLeadgen: async () => { throw new Error('403'); } });
  const out = await onb.connectByToken('T1', 'EAAtoken_bem_longo_valido_xx', deps);
  assert.equal(out.subscribed.messages, false);
  assert.ok(calls.persist, 'persistiu mesmo com falha de subscribe');
});
