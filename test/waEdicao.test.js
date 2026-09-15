'use strict';
// waEdicao.test.js — edição cifrada do WhatsApp (sem DB). Paridade com o WhatsApp, etapa 2.
// A edição é cifrada aqui do mesmo jeito que o WhatsApp faz (HKDF + AES-GCM sem AAD, autor = @lid) e o
// protobuf é montado à mão com os números de campo do WAProto — nenhum dado real.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const w = require('../src/waEdicao');

// protobuf mínimo p/ montar o Message editado
const varint = (n) => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n); return Buffer.from(b); };
const ld = (campo, buf) => Buffer.concat([varint((campo << 3) | 2), varint(buf.length), buf]);
const txt = (campo, s) => ld(campo, Buffer.from(s, 'utf8'));
const editado = (inner) => ld(12, Buffer.concat([ld(1, txt(3, 'ALVO1')), ld(14, inner)]));   // protocolMessage{key, editedMessage}

const SEGREDO = crypto.randomBytes(32);
const LID = '257384589033642@lid';

test('decifra uma edição de texto e lê o texto novo', () => {
  const claro = editado(txt(1, 'Bom dia, ok!'));   // editedMessage.conversation
  const { encIv, encPayload } = w._cifrarParaTeste({ segredo: SEGREDO, alvoId: 'ALVO1', autor: LID, claro });
  const volta = w.decifrar({ segredo: SEGREDO, encIv, encPayload, alvoId: 'ALVO1', autor: LID });
  assert.equal(w.textoDaEdicao(volta), 'Bom dia, ok!');
});

test('texto longo (extendedTextMessage) e legenda de foto/vídeo', () => {
  assert.equal(w.textoDaEdicao(editado(ld(6, txt(1, 'texto com link https://x.y')))), 'texto com link https://x.y');
  assert.equal(w.textoDaEdicao(editado(ld(3, txt(3, 'legenda nova da foto')))), 'legenda nova da foto');
  assert.equal(w.textoDaEdicao(editado(ld(9, txt(7, 'legenda do vídeo')))), 'legenda do vídeo');
});

test('@lid errado, segredo errado ou uso errado não abrem (a tag GCM não fecha)', () => {
  const claro = editado(txt(1, 'x'));
  const e = w._cifrarParaTeste({ segredo: SEGREDO, alvoId: 'ALVO1', autor: LID, claro });
  assert.throws(() => w.decifrar({ segredo: SEGREDO, ...e, alvoId: 'ALVO1', autor: '5519999990000@s.whatsapp.net' }));
  assert.throws(() => w.decifrar({ segredo: crypto.randomBytes(32), ...e, alvoId: 'ALVO1', autor: LID }));
  assert.throws(() => w.decifrar({ segredo: SEGREDO, ...e, alvoId: 'ALVO1', autor: LID, uso: 'Event Edit' }));
});

test('bytes no formato em que a API serializa ({"0":12,...}) e em base64', () => {
  const b = Buffer.from([1, 2, 250]);
  assert.deepEqual(w.bytes({ 0: 1, 1: 2, 2: 250 }), b);
  assert.deepEqual(w.bytes({ 10: 9, 2: 250, 0: 1, 1: 2 }).subarray(0, 3), b, 'ordena as chaves numericamente');
  assert.deepEqual(w.bytes(b.toString('base64')), b);
});

test('reconhece a edição cifrada (e não confunde com outra coisa)', () => {
  assert.equal(w.ehEdicaoCifrada({ secretEncryptedMessage: { targetMessageKey: { id: 'A' }, secretEncType: 2 } }), true);
  assert.equal(w.ehEdicaoCifrada({ secretEncryptedMessage: { targetMessageKey: { id: 'A' }, secretEncType: 'MESSAGE_EDIT' } }), true);
  assert.equal(w.ehEdicaoCifrada({ conversation: 'oi' }), false);
  assert.equal(w.ehEdicaoCifrada({ secretEncryptedMessage: {} }), false, 'sem alvo não é edição aplicável');
});

test('pares número <-> @lid da key do payload, nas duas ordens', () => {
  assert.deepEqual(w.paresDaKey({ participant: '257384589033642@lid', participantAlt: '5519992605603@s.whatsapp.net' }),
    [{ lid: '257384589033642@lid', pn: '5519992605603@s.whatsapp.net' }]);
  assert.deepEqual(w.paresDaKey({ remoteJid: '5519992605603:12@s.whatsapp.net', remoteJidAlt: '275560000001451@lid' }),
    [{ lid: '275560000001451@lid', pn: '5519992605603@s.whatsapp.net' }], 'tira o sufixo de aparelho');
  assert.deepEqual(w.paresDaKey({ remoteJid: '5519992605603@s.whatsapp.net', remoteJidAlt: '5519992605603@s.whatsapp.net' }), []);
});

test('editar a legenda de uma foto troca só a legenda, mantendo o marcador de mídia', () => {
  assert.equal(w._comMarcador('legenda nova', '[imagem] legenda velha'), '[imagem] legenda nova');
  assert.equal(w._comMarcador('texto novo', 'texto velho'), 'texto novo');
});

test('protobuf truncado não derruba nada', () => {
  assert.equal(w.textoDaEdicao(Buffer.from([0x62, 0x50, 0x01])), null);
});
