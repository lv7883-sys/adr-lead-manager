'use strict';
//
// ADR-031 — parse de reação / sticker / view-once no webhook (sem DB).
//
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeMessage, detectarMidia, detectarReacao, _idsRecibosLeituraInbound } = require('../src/routes/webhook');

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

// ADR-042 Fase 2 — recibo de leitura do inbound (payloads REAIS observados em produção).
// A Evolution manda o status no TOPO do data (não em .key): { keyId, remoteJid, fromMe, status }.
const upd = (entries) => ({ event: 'messages.update', data: entries });

test('read-receipt inbound (fromMe=false, READ) → devolve o keyId p/ casar external_message_id', () => {
  const ids = _idsRecibosLeituraInbound(upd([
    { keyId: '3AD1977D67C460B43AF9', remoteJid: '54112376897777@lid', fromMe: false, status: 'READ' },
  ]));
  assert.deepEqual(ids, ['3AD1977D67C460B43AF9']);
});

test('read-receipt do NOSSO outbound (fromMe=true) é ignorado (é ack, não leitura de inbound)', () => {
  const ids = _idsRecibosLeituraInbound(upd([
    { keyId: '3EB09E87BA4D8C5386C8D6', remoteJid: '157608841375753@lid', fromMe: true, status: 'READ' },
  ]));
  assert.deepEqual(ids, []);
});

test('mistura fromMe true/false + dedup: só os inbound lidos, sem repetir', () => {
  const ids = _idsRecibosLeituraInbound(upd([
    { keyId: 'A', fromMe: false, status: 'READ' },
    { keyId: 'B', fromMe: true, status: 'READ' },   // outbound → fora
    { keyId: 'A', fromMe: false, status: 'READ' },   // duplicado → dedup
    { keyId: 'C', fromMe: false, status: 'DELIVERY_ACK' }, // não é read → fora
  ]));
  assert.deepEqual(ids.sort(), ['A']);
});

test('status não-leitura (delivered/sent) não gera marcação', () => {
  assert.deepEqual(_idsRecibosLeituraInbound(upd([{ keyId: 'X', fromMe: false, status: 'DELIVERY_ACK' }])), []);
});
