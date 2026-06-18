'use strict';

const crypto = require('crypto');
const express = require('express');
const { withTenant } = require('../db');
const logger = require('../logger');
const engine = require('../engine');
const staffSamples = require('../staffSamples');
const evolution = require('../evolution');
const gemini = require('../gemini');
const media = require('../media');
const { decrypt } = require('../crypto');

const router = express.Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Comparação de tokens em tempo constante (evita timing attack).
function tokenMatches(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Normaliza o payload do provedor (Z-API ou Evolution API) num formato único.
function normalizeMessage(body) {
  // Z-API: { phone, messageId, fromMe, senderName, text: { message } }
  if (body && body.phone) {
    return {
      externalId: String(body.phone),
      externalMessageId: body.messageId ? String(body.messageId) : null,
      fromMe: Boolean(body.fromMe),
      sender: body.senderName || body.chatName || null,
      source: null,
      body: body.text?.message ?? body.image?.caption ?? null,
      // grupo nunca é um lead (vale p/ qualquer tenant) — sinaliza p/ o guard.
      isGroup: Boolean(body.isGroup) || /@g\.us$/.test(String(body.phone)),
    };
  }
  // Evolution API: { data: { key: { remoteJid, fromMe, id }, pushName, message }, source }
  const data = body?.data;
  if (data && data.key) {
    const jid = data.key.remoteJid || '';
    const m = data.message || {};
    const media = detectarMidia(m);
    let texto = m.conversation ?? m.extendedTextMessage?.text ?? null;
    if (!texto && media) texto = media.placeholder;   // body legível p/ histórico
    return {
      externalId: jid.split('@')[0] || jid,
      externalMessageId: data.key.id ? String(data.key.id) : null,
      fromMe: Boolean(data.key.fromMe),
      sender: data.pushName || null,
      // device de origem (android/ios/web = recepção digitando; outros = API/automático)
      source: data.source ?? body.source ?? null,
      body: texto,
      media: media ? { ...media, rawMessage: m, messageKey: data.key } : null,
      // grupo nunca é um lead (vale p/ qualquer tenant) — sinaliza p/ o guard.
      isGroup: /@g\.us$/.test(jid),
    };
  }
  return null;
}

// ADR-016 — detecta mídia no objeto `message` da Evolution. Devolve metadados +
// placeholder pro body, ou null se for texto puro.
function detectarMidia(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.audioMessage) {
    return { kind: 'audio', mimetype: m.audioMessage.mimetype || 'audio/ogg', filename: null, placeholder: '[áudio]' };
  }
  if (m.imageMessage) {
    return { kind: 'image', mimetype: m.imageMessage.mimetype || 'image/jpeg', filename: null,
             placeholder: m.imageMessage.caption ? `[imagem] ${m.imageMessage.caption}` : '[imagem]' };
  }
  if (m.videoMessage) {
    return { kind: 'video', mimetype: m.videoMessage.mimetype || 'video/mp4', filename: null,
             placeholder: m.videoMessage.caption ? `[vídeo] ${m.videoMessage.caption}` : '[vídeo]' };
  }
  if (m.documentMessage || m.documentWithCaptionMessage) {
    const d = m.documentMessage || m.documentWithCaptionMessage.message.documentMessage;
    const nome = (d && d.fileName) || 'arquivo';
    return { kind: 'document', mimetype: (d && d.mimetype) || 'application/octet-stream', filename: nome,
             placeholder: `[documento: ${nome}]` };
  }
  return null;
}

// 200 silencioso: reconhece o webhook sem revelar nada nem processar.
function silentOk(res) {
  return res.status(200).json({ status: 'ignored' });
}

/**
 * Middleware: autentica o tenant pelo header X-ZAPI-TOKEN ANTES de processar.
 *  - tenantId inválido / inexistente  -> 200 silencioso (não vaza existência)
 *  - Lead Manager inativo no tenant    -> 200 silencioso
 *  - token ausente / divergente        -> 401
 *  - ok                                -> req.tenant preenchido, segue adiante
 */
async function authenticateTenant(req, res, next) {
  const tenantId = req.params.tenantId;
  const log = logger.child({ tenant_id: tenantId });

  if (!UUID_RE.test(tenantId || '')) {
    log.info('webhook.rejected', { reason: 'invalid_tenant_id' });
    return silentOk(res);
  }

  try {
    const tenant = await withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        'SELECT id, lead_manager_active, zapi_token FROM tenants WHERE id = $1',
        [tenantId]
      );
      return rows[0] || null;
    });

    if (!tenant) {
      log.info('webhook.ignored', { reason: 'unknown_tenant' });
      return silentOk(res);
    }
    if (!tenant.lead_manager_active) {
      log.info('webhook.ignored', { reason: 'lead_manager_inactive' });
      return silentOk(res);
    }

    const provided = req.get('X-ZAPI-TOKEN');
    if (!tokenMatches(tenant.zapi_token || '', provided || '')) {
      log.warn('webhook.unauthorized', { reason: 'invalid_zapi_token' });
      return res.status(401).json({ error: 'invalid token' });
    }

    req.tenant = tenant;
    req.log = log;
    return next();
  } catch (err) {
    log.error('webhook.auth_error', { error: err.message });
    return res.status(500).json({ error: 'internal error' });
  }
}

/**
 * Handler: responde 200 IMEDIATAMENTE e roteia a mensagem para o motor de
 * funil (ADR-003) de forma assíncrona. Falhas no processamento são logadas,
 * nunca propagadas — o provedor não deve receber erro nem reentregar.
 */
async function handleZapiWebhook(req, res) {
  const tenant = req.tenant;
  const log = req.log;
  const msg = normalizeMessage(req.body);

  // ACK imediato (processamento é assíncrono).
  res.status(200).json({ status: 'ok' });

  if (!msg || !msg.externalId) {
    log.info('webhook.no_message', { reason: 'unparseable_payload' });
    return;
  }
  // Grupo (@g.us) NUNCA vira lead — guard genérico, antes de qualquer ingestão
  // (sem criar lead nem capturar staff_sample; o id de grupo não é telefone).
  if (msg.isGroup) {
    log.info('webhook.skipped', { reason: 'group_message' });
    return;
  }
  if (msg.fromMe) {
    log.info('webhook.skipped', { reason: 'from_me' });
    // Aprendizado de estilo: guarda a mensagem da recepção (best-effort).
    staffSamples
      .captureOutbound(tenant.id, msg, req.body)
      .catch((err) => log.warn('staff_sample.unhandled', { error: err.message }));
    return;
  }

  // ADR-016 — mídia recebida: baixa, grava em disco e (áudio) transcreve ANTES do
  // funil, pra a mensagem ser persistida já com a mídia. Best-effort, não trava.
  const processar = async () => {
    if (msg.media) {
      try {
        const cred = await withTenant(tenant.id, async (c) => (
          await c.query('SELECT evolution_instance, evolution_token_enc FROM tenants WHERE id = $1', [tenant.id])
        ).rows[0]);
        const instance = cred && cred.evolution_instance;
        const apikey = cred && decrypt(cred.evolution_token_enc);
        if (instance && apikey) {
          const saved = await media.salvarMidia({ tenantId: tenant.id, instance, apikey, media: msg.media });
          if (saved) {
            msg.media.url = saved.media_url;
            msg.media.type = saved.media_type;
            msg.media.filename = saved.media_filename;
            if (saved.media_type === 'audio') {
              try {
                msg.media.transcription = await gemini.transcribeAudio({ base64: saved.base64, mimetype: saved.mimetype });
              } catch (e) { log.warn('media.transcribe_failed', { error: e.message }); }
            }
            log.info('media.captured', { kind: saved.media_type, transcrito: !!msg.media.transcription });
          }
        } else {
          log.warn('media.no_evolution_cred', {});
        }
      } catch (e) { log.warn('media.capture_error', { error: e.message }); }
    }
    await engine.processInbound(tenant, msg, req.body);
  };
  // Funil de triagem (Portões 0/1/2). Fire-and-forget com captura de erro.
  processar().catch((err) => log.error('engine.unhandled_error', { error: err.message }));
}

router.post('/zapi/:tenantId', authenticateTenant, handleZapiWebhook);

module.exports = router;
