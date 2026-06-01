'use strict';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// E.164: '+' seguido de 1 a 15 dígitos, o primeiro entre 1-9.
const E164_RE = /^\+[1-9]\d{1,14}$/;

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
// "HH:MM-HH:MM" 24h, ou a string "closed".
const TIME_RANGE_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const isE164 = (v) => typeof v === 'string' && E164_RE.test(v);

// Normaliza um identificador de telefone vindo do provedor para E.164.
// Z-API entrega "5511988887777" (sem '+'); known_contacts armazena "+5511...".
function toE164(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits ? `+${digits}` : null;
}

// Retorna mensagem de erro (string) ou null se válido.
function validateBusinessHours(bh) {
  if (typeof bh !== 'object' || bh === null || Array.isArray(bh)) {
    return 'business_hours deve ser um objeto { dia: "HH:MM-HH:MM" }';
  }
  for (const [day, value] of Object.entries(bh)) {
    if (!DAYS.includes(day)) {
      return `dia inválido em business_hours: "${day}" (use mon..sun)`;
    }
    if (value !== 'closed' && !TIME_RANGE_RE.test(value)) {
      return `horário inválido para "${day}": "${value}" (esperado "HH:MM-HH:MM" ou "closed")`;
    }
  }
  return null;
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
  validateBusinessHours,
};
