'use strict';
//
// notificacao.js — Bloco 4. Notifica a recepção via WhatsApp (Evolution) quando
// um lead chega ou precisa de atenção. Config por tenant; best-effort (nunca
// derruba o funil); anti-spam por lead (30 min).
//
const { withTenant } = require('./db');
const evolution = require('./evolution');
const { decrypt } = require('./crypto');
const logger = require('./logger');

const ANTISPAM_MS = 30 * 60 * 1000;

function _mensagem(tipo, dados, base) {
  const b = (base || '').replace(/\/+$/, '');
  const nome = dados.name || 'Desconhecido';
  if (tipo === 'novo_lead') {
    const inst = dados.instrument || 'aulas';
    return `🔔 Novo lead: ${nome} quer informações sobre ${inst}. Acesse: ${b}/leads`;
  }
  if (tipo === 'nova_msg') {
    return `💬 ${dados.name || 'Um lead'} respondeu. Acesse o lead: ${b}/leads/${dados.leadId}`;
  }
  if (tipo === 'revisao') {
    return `🔎 Mensagem para revisar — pode ser um lead. Acesse: ${b}/leads/revisar`;
  }
  return null;
}

// tipo: 'novo_lead' | 'nova_msg' | 'revisao'. dados: { leadId?, name?, instrument?, confidence? }
async function notificarRecepcao(tenantId, tipo, dados = {}) {
  try {
    const cfg = await withTenant(tenantId, async (c) => {
      const t = (await c.query(
        `SELECT notif_enabled, notif_phones, notif_min_confidence, notif_link_base,
                evolution_instance, evolution_token_enc
           FROM tenants WHERE id = $1`, [tenantId]
      )).rows[0] || {};
      let lastSent = null;
      if (dados.leadId) {
        lastSent = (await c.query('SELECT notif_last_sent FROM leads WHERE id = $1', [dados.leadId])).rows[0]?.notif_last_sent || null;
      }
      return { ...t, lastSent };
    });

    if (!cfg.notif_enabled) { logger.info('notif.skipped', { tenant_id: tenantId, reason: 'disabled' }); return; }
    const phones = Array.isArray(cfg.notif_phones) ? cfg.notif_phones.filter(Boolean) : [];
    if (!phones.length) { logger.info('notif.skipped', { tenant_id: tenantId, reason: 'no_phones' }); return; }

    // Gatilho 1 exige confiança mínima.
    if (tipo === 'novo_lead') {
      const min = cfg.notif_min_confidence != null ? Number(cfg.notif_min_confidence) : 0.85;
      const conf = dados.confidence != null ? Number(dados.confidence) : 1;
      if (conf < min) { logger.info('notif.skipped', { tenant_id: tenantId, reason: 'below_min_confidence' }); return; }
    }

    // Anti-spam por lead (30 min).
    if (dados.leadId && cfg.lastSent && (Date.now() - new Date(cfg.lastSent).getTime()) < ANTISPAM_MS) {
      logger.info('notif.skipped', { tenant_id: tenantId, lead_id: dados.leadId, reason: 'antispam' });
      return;
    }

    const msg = _mensagem(tipo, dados, cfg.notif_link_base);
    if (!msg) return;
    const instance = cfg.evolution_instance;
    const apikey = decrypt(cfg.evolution_token_enc);
    if (!instance || !apikey) { logger.warn('notif.skipped', { tenant_id: tenantId, reason: 'no_evolution' }); return; }

    let enviou = 0;
    for (const phone of phones) {
      try {
        await evolution.sendText({ instance, apikey }, phone, msg);
        enviou++;
      } catch (e) {
        logger.warn('notif.falhou', { tenant_id: tenantId, tipo, error: e.message });
      }
    }
    if (enviou > 0 && dados.leadId) {
      await withTenant(tenantId, (c) => c.query('UPDATE leads SET notif_last_sent = now() WHERE id = $1', [dados.leadId]));
    }
    if (enviou > 0) logger.info('notif.enviada', { tenant_id: tenantId, tipo, destinos: enviou, lead_id: dados.leadId || null });
  } catch (err) {
    logger.warn('notif.erro', { tenant_id: tenantId, tipo, error: err.message });
  }
}

module.exports = { notificarRecepcao };
