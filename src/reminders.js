'use strict';

const logger = require('./logger');

// Lembrete de trial para o Leo (MVP — apenas Leo, ADR-004 Decisão 2 / DP-002).
// Canal: log estruturado + (se configurado) email simples via nodemailer.
async function notifyTrialReminder({ marco, tenantId, feature, daysRemaining, validUntil }) {
  // Log estruturado é o canal garantido.
  logger.info('reminder.trial', {
    marco,
    tenant_id: tenantId,
    feature,
    dias_restantes: daysRemaining,
    valid_until: validUntil,
  });

  const host = process.env.SMTP_HOST;
  const to = process.env.REMINDER_EMAIL || process.env.PLATFORM_ADMIN_EMAIL;
  if (!host || !to) return { emailed: false, reason: 'smtp_not_configured' };

  try {
    // Lazy-require: nodemailer só é carregado quando há SMTP configurado.
    const nodemailer = require('nodemailer');
    const transport = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
    await transport.sendMail({
      from: process.env.SMTP_FROM || to,
      to,
      subject: `[Lead Manager] Trial ${marco} — tenant ${tenantId}`,
      text:
        `Marco: ${marco}\nFeature: ${feature}\nDias restantes: ${daysRemaining}\n` +
        `Expira em: ${validUntil}\nTenant: ${tenantId}`,
    });
    return { emailed: true };
  } catch (err) {
    logger.warn('reminder.email_failed', { marco, tenant_id: tenantId, error: err.message });
    return { emailed: false, reason: 'error' };
  }
}

module.exports = { notifyTrialReminder };
