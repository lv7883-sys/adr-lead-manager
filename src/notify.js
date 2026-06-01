'use strict';

const logger = require('./logger');

const RECEPTIONIST_MESSAGE =
  'Nova mensagem de lead. Acesse o dashboard para aprovar a resposta.';

// Notifica a recepcionista via WhatsApp (Z-API). Best-effort: se faltar
// configuração (credenciais Z-API ou número de notificação), apenas registra
// e segue — nunca derruba o processamento do funil.
async function notifyReceptionist({ tenantId, to }) {
  const log = logger.child({ tenant_id: tenantId });

  if (!to) {
    log.warn('notify.skipped', { reason: 'no_notification_whatsapp' });
    return { sent: false, reason: 'no_recipient' };
  }
  const instanceId = process.env.ZAPI_INSTANCE_ID;
  const token = process.env.ZAPI_TOKEN;
  if (!instanceId || !token) {
    log.warn('notify.skipped', { reason: 'zapi_not_configured' });
    return { sent: false, reason: 'zapi_not_configured' };
  }

  try {
    const url = `https://api.z-api.io/instances/${instanceId}/token/${token}/send-text`;
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.ZAPI_CLIENT_TOKEN) headers['Client-Token'] = process.env.ZAPI_CLIENT_TOKEN;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ phone: to, message: RECEPTIONIST_MESSAGE }),
    });
    if (!res.ok) {
      log.warn('notify.failed', { status: res.status });
      return { sent: false, reason: `http_${res.status}` };
    }
    log.info('notify.sent', {});
    return { sent: true };
  } catch (err) {
    log.warn('notify.failed', { error: err.message });
    return { sent: false, reason: 'error' };
  }
}

module.exports = { notifyReceptionist, RECEPTIONIST_MESSAGE };
