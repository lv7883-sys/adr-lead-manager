'use strict';

// webhook-meta.js — recepção dos webhooks da Meta (Lead Ads + Instagram DM +
// Facebook Messenger). P0 da arquitetura do Lead Manager (canal principal de
// ingestão; ver lead-manager-product-architecture). Por enquanto só faz o handshake
// de verificação e LOGA o payload — o processamento vem depois.

const crypto = require('crypto');
const express = require('express');

const router = express.Router();

// Comparação em tempo constante (evita timing attack) — mesmo padrão do webhook.js.
function tokenMatches(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// GET /webhook/meta — handshake de verificação da Meta.
// A Meta chama com ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
// Se hub.verify_token bater com META_WEBHOOK_VERIFY_TOKEN, devolve o hub.challenge
// (texto puro). Caso contrário, 403.
router.get('/meta', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN || '';

  if (mode === 'subscribe' && expected && tokenMatches(expected, String(token || ''))) {
    return res.status(200).type('text/plain').send(String(challenge ?? ''));
  }
  return res.sendStatus(403);
});

// POST /webhook/meta — recebe os eventos (Lead Ads / IG DM / Messenger).
// Responde 200 IMEDIATAMENTE (a Meta exige 200 rápido; senão reenvia e acaba
// desabilitando a inscrição). Por enquanto só loga o payload — sem processar.
router.post('/meta', (req, res) => {
  res.sendStatus(200);
  try {
    console.log('[webhook/meta] payload:', JSON.stringify(req.body));
  } catch (_e) {
    console.log('[webhook/meta] payload (não serializável):', req.body);
  }
});

module.exports = router;
