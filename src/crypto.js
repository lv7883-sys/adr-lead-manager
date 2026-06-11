'use strict';
//
// crypto.js — AES-256-GCM com chave derivada de LM_ENCRYPTION_KEY.
//
// Chave PRÓPRIA do Lead Manager — NÃO compartilhada com o Scheduler (que usa
// APP_ENCRYPTION_KEY). NÃO trocar após uso: muda a chave => os ciphertexts já
// gravados (ex.: evolution_token_enc) ficam ilegíveis.
//
// Layout do ciphertext: base64( iv[12] | tag[16] | ciphertext ). Mesmo formato do
// Scheduler (lib/crypto.js), porém com chave independente — assim o LM é autônomo.
//
const crypto = require('crypto');

const ENC_KEY = crypto
  .createHash('sha256')
  .update(process.env.LM_ENCRYPTION_KEY || 'insecure-dev-key')
  .digest();

function encrypt(text) {
  if (text == null || text === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function decrypt(b64) {
  if (!b64) return '';
  try {
    const raw = Buffer.from(b64, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch (_e) {
    return '';
  }
}

module.exports = { encrypt, decrypt };
