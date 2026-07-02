'use strict';
//
// ADR-031 — parse de reação / sticker / view-once no webhook (sem DB).
//
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeMessage, detectarMidia, detectarReacao } = require('../src/routes/webhook');

// Envelope Evolution mínimo.
const evo = (message, key = {}) => ({
  data: { key: { id: 'M1', fromMe: false, remoteJid: '5519999990000@s.whatsapp.net', ...key }, pushName: 'Lead', message },
});

test('reação inbound: extrai emoji pro body + msg.reaction, sem virar mídia', () => {
  const msg = normalizeMessage(evo({ reactionMessage: { text: '🙏', key: { id: 'ALVO-123' } } }));
  assert.equal(msg.body, '[reação] 🙏');
  assert.deepEqual(msg.reaction, { emoji: '🙏', targetId: 'ALVO-123' });
  assert.equal(msg.media, null);
});

test('des-reação (text vazio) não vira reação nem bolha', () => {
  assert.equal(detectarReacao({ reactionMessage: { text: '', key: { id: 'X' } } }), null);
  const msg = normalizeMessage(evo({ reactionMessage: { text: '' } }));
  assert.equal(msg.body, null);
  assert.equal(msg.reaction, null);
});

test('sticker: kind image/webp, baixável e com placeholder [figurinha]', () => {
  const media = detectarMidia({ stickerMessage: { mimetype: 'image/webp', url: 'x' } });
  assert.equal(media.kind, 'image');
  assert.equal(media.mimetype, 'image/webp');
  const msg = normalizeMessage(evo({ stickerMessage: { mimetype: 'image/webp', url: 'x' } }));
  assert.equal(msg.body, '[figurinha]');
  assert.ok(msg.media && msg.media.rawMessage && msg.media.messageKey);
  assert.equal(msg.reaction, null);
});

test('view-once cifrada: placeholder legível, sem mídia', () => {
  const msg = normalizeMessage(evo({ secretEncryptedMessage: { encIv: 'a', encPayload: 'b' } }));
  assert.equal(msg.body, '[mensagem de visualização única]');
  assert.equal(msg.media, null);
  assert.equal(msg.reaction, null);
});

test('texto puro segue intacto (sem reaction/media)', () => {
  const msg = normalizeMessage(evo({ conversation: 'quero aula de violino 🎻' }));
  assert.equal(msg.body, 'quero aula de violino 🎻');
  assert.equal(msg.reaction, null);
  assert.equal(msg.media, null);
});

test('imagem com legenda mantém o comportamento anterior', () => {
  const msg = normalizeMessage(evo({ imageMessage: { mimetype: 'image/jpeg', caption: 'olha' } }));
  assert.equal(msg.media.kind, 'image');
  assert.equal(msg.body, '[imagem] olha');
});
