'use strict';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// E.164: '+' seguido de 1 a 15 dígitos, o primeiro entre 1-9.
const E164_RE = /^\+[1-9]\d{1,14}$/;

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const isE164 = (v) => typeof v === 'string' && E164_RE.test(v);

// Normaliza um identificador de telefone vindo do provedor para E.164.
// Z-API entrega "5511988887777" (sem '+'); known_contacts armazena "+5511...".
function toE164(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits ? `+${digits}` : null;
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

module.exports = {
  UUID_RE,
  E164_RE,
  isUuid,
  isE164,
  toE164,
  isStringArray,
};
