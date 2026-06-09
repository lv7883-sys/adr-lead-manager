'use strict';

// Token de opt-out (LGPD) — link único por lead no rodapé da 1ª mensagem.
// É um token assinado por HMAC-SHA256 que CARREGA tenant_id + lead_id (um HMAC
// "puro" do lead_id não poderia ser revertido para identificar o lead). O
// segredo é OPTOUT_SECRET; cai para JWT_SECRET se aquele não estiver definido.
//
// Mesma lógica é reimplementada no Scheduler (routes/optout.js) com `crypto`
// nativo — sem dependências novas dos dois lados.

const crypto = require('crypto');

function secret() {
  return process.env.OPTOUT_SECRET || process.env.JWT_SECRET || '';
}

function makeOptoutToken(tenantId, leadId) {
  const payload = Buffer.from(JSON.stringify({ t: tenantId, l: leadId })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

// Retorna { tenantId, leadId } se o token for válido; null caso contrário.
function verifyOptoutToken(token) {
  if (typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!o || !o.t || !o.l) return null;
    return { tenantId: o.t, leadId: o.l };
  } catch {
    return null;
  }
}

module.exports = { makeOptoutToken, verifyOptoutToken };
