'use strict';

// Testes UNITÁRIOS (sem DB) dos helpers puros da resiliência a 503 no Portão 1.
// O fluxo end-to-end (buffer → reprocessamento → Revisar) depende de DB e roda nos
// testes de integração (engine.test.js) / na verificação manual no container.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const engine = require('../src/engine');

// ---- _isTransientAIError: o que entra no buffer vs. o que segue o caminho antigo ----
test('_isTransientAIError: 503/timeout/rede são transitórios', () => {
  const t = engine._isTransientAIError;
  assert.equal(t(new Error('[503 Service Unavailable] This model is currently experiencing high demand.')), true);
  assert.equal(t(new Error('[429 Too Many Requests]')), true);
  assert.equal(t(new Error('[500 Internal Server Error]')), true);
  assert.equal(t(new Error('request timed out')), true);
  assert.equal(t(new Error('fetch failed')), true);
  assert.equal(t(new Error('ECONNRESET')), true);
});

test('_isTransientAIError: erro de contrato NÃO é transitório (não vai pro buffer)', () => {
  const t = engine._isTransientAIError;
  assert.equal(t(new SyntaxError('Unexpected token < in JSON at position 0')), false);
  assert.equal(t(new Error('GEMINI_API_KEY não configurada')), false);
});

// ---- _pendingWindowExpired: a janela de 15min ----
test('_pendingWindowExpired: dentro da janela = false; fora = true; nulo = true', () => {
  const w = engine.PENDING_CLASSIFICATION_WINDOW_MS;
  assert.equal(engine._pendingWindowExpired(new Date(Date.now() - 60 * 1000)), false);      // 1 min
  assert.equal(engine._pendingWindowExpired(new Date(Date.now() - (w + 1000))), true);       // > 15 min
  assert.equal(engine._pendingWindowExpired(null), true);                                    // sem marca → Revisar
});

// ---- _decideConversaRoute: o mapa de intent → funil/route (provado pelo Osvaldo) ----
const base = { confidence: 0.9, reasoning: 'x', conversation_state: 'AGUARDANDO_RECEPCAO', state_reasoning: 's' };

test('NOVA_OPORTUNIDADE + aguardando recepção → funil (cls, com rascunho)', () => {
  const d = engine._decideConversaRoute({ ...base, intent: 'NOVA_OPORTUNIDADE', is_lead: true }, false);
  assert.ok(d.cls && !d.route);
  assert.equal(d.cls.is_lead, true);
});

test('NOVA_OPORTUNIDADE + contato de relacionamento → Revisar (nunca auto-funil)', () => {
  const d = engine._decideConversaRoute({ ...base, intent: 'NOVA_OPORTUNIDADE', is_lead: true }, true);
  assert.ok(d.route && !d.cls);
  assert.equal(d.route.status, 'REVIEW_QUEUE');
  assert.equal(d.route.intent, 'RELACIONAMENTO_OPORTUNIDADE');
});

test('NOVA_OPORTUNIDADE + RESOLVIDO/AGUARDANDO_CLIENTE → funil SEM rascunho', () => {
  const d = engine._decideConversaRoute(
    { ...base, intent: 'NOVA_OPORTUNIDADE', is_lead: true, conversation_state: 'RESOLVIDO' }, false);
  assert.equal(d.route.status, 'QUALIFYING');
  assert.equal(d.route.reviewQueue, false);
});

test('ROTINA_CLIENTE → NOT_LEAD (não-classificadas)', () => {
  const d = engine._decideConversaRoute({ ...base, intent: 'ROTINA_CLIENTE', is_lead: false }, false);
  assert.equal(d.route.status, 'NOT_LEAD');
});

test('INDEFINIDO → Revisar', () => {
  const d = engine._decideConversaRoute({ ...base, intent: 'INDEFINIDO', is_lead: false }, false);
  assert.equal(d.route.status, 'REVIEW_QUEUE');
  assert.equal(d.route.intent, 'INDEFINIDO');
});
