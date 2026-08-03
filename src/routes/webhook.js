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
const autoReply = require('../autoReply');   // ADR-006+ resposta automática fora do horário
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
    const reaction = detectarReacao(m);   // ADR-031 — reação emoji (não é mídia)
    let texto = m.conversation ?? m.extendedTextMessage?.text ?? null;
    if (!texto && media) texto = media.placeholder;   // body legível p/ histórico
    if (!texto && reaction) texto = `[reação] ${reaction.emoji}`;   // ADR-031: não vira bolha vazia
    if (!texto && ehViewOnce(m)) texto = '[mensagem de visualização única]';   // ADR-031 (cifrada, não baixável)
    return {
      externalId: jid.split('@')[0] || jid,
      externalMessageId: data.key.id ? String(data.key.id) : null,
      fromMe: Boolean(data.key.fromMe),
      sender: data.pushName || null,
      // device de origem (android/ios/web = recepção digitando; outros = API/automático)
      source: data.source ?? body.source ?? null,
      body: texto,
      media: media ? { ...media, rawMessage: m, messageKey: data.key } : null,
      // ADR-031 — reação é META-SINAL, não mensagem: o engine NÃO classifica nem gera
      // rascunho (senão um 👍 vira resposta-fantasma). `targetId` = msg-alvo (p/ exibição
      // grudada futura; já preservado no raw). null quando não é reação.
      reaction,
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
  // ADR-031 — figurinha = webp; tratada como imagem (baixa via getBase64FromMediaMessage e
  // renderiza no <img> já existente). O raw preserva stickerMessage p/ quem quiser distinguir.
  if (m.stickerMessage) {
    return { kind: 'image', mimetype: m.stickerMessage.mimetype || 'image/webp', filename: null,
             placeholder: '[figurinha]' };
  }
  return null;
}

// ADR-031 — reação emoji (WhatsApp). NÃO é mídia (nada a baixar): o emoji vive em
// reactionMessage.text e o alvo em reactionMessage.key.id. Uma "des-reação" chega com text
// vazio → devolve null (não vira bolha). Retorna { emoji, targetId } ou null.
function detectarReacao(m) {
  const r = m && m.reactionMessage;
  if (!r || !r.text) return null;
  return { emoji: String(r.text), targetId: (r.key && r.key.id) ? String(r.key.id) : null };
}

// ADR-031 — view-once (visualização única). A forma nova (secretEncryptedMessage) é cifrada
// e não baixável; os wrappers viewOnce* embrulham a mídia real. Aqui só sinalizamos p/ o
// placeholder — decodificar/baixar view-once é frente futura, fora deste ADR.
function ehViewOnce(m) {
  return !!(m && (m.secretEncryptedMessage || m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension));
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
// ── Fatia 1 WhatsApp-like: status de entrega/leitura das NOSSAS mensagens ──────────
// Espelha o mapStatus do scheduler (dashboard/routes/webhook.js): ack Baileys/Evolution
// (string ou numérico) → 'sent'|'delivered'|'read'. Só o que vira check; pending/failed
// não avançam. NULL = ainda sem ack.
function _mapAck(s) {
  const v = String(s == null ? '' : s).toUpperCase();
  const m = {
    SERVER_ACK: 'sent', SENT: 'sent', '2': 'sent',
    DELIVERY_ACK: 'delivered', DELIVERED: 'delivered', '3': 'delivered',
    READ: 'read', PLAYED: 'read', '4': 'read', '5': 'read',
  };
  return m[v] || null;
}

// Extrai [{ id, ack }] do payload de status (espelha collectUpdates do scheduler: aceita
// formatos variados). id = key.id da Evolution → casa com staff_outbound_samples.external_message_id.
function _collectAckUpdates(body) {
  const out = [];
  const data = body && body.data != null ? body.data : body;
  const arr = Array.isArray(data) ? data : [data];
  for (const d of arr) {
    if (!d || typeof d !== 'object') continue;
    const id = (d.key && d.key.id) || d.keyId || d.id || (d.message && d.message.key && d.message.key.id);
    const ack = _mapAck(d.status || (d.update && d.update.status) || d.messageStatus);
    if (id && ack) out.push({ id: String(id), ack });
  }
  return out;
}

// Grava o ack na saída correspondente (staff_outbound_samples) por external_message_id.
// MONOTÔNICO (nunca regride: read>delivered>sent) e IDEMPOTENTE (mesmo ack = no-op).
// Ignora se não achar a mensagem (WHERE não casa → 0 linhas; nunca cria linha nova).
async function atualizarAckStatus(tenantId, body, log) {
  const updates = _collectAckUpdates(body);
  if (!updates.length) return;
  const n = await withTenant(tenantId, async (c) => {
    let tot = 0;
    for (const u of updates) {
      const r = await c.query(
        `UPDATE staff_outbound_samples
            SET ack_status = $2
          WHERE tenant_id = $1 AND external_message_id = $3
            AND (ack_status IS NULL OR
                 (CASE ack_status WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 0 END)
                 < (CASE $2       WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 0 END))`,
        [tenantId, u.ack, u.id]
      );
      tot += r.rowCount;
    }
    return tot;
  });
  if (log) log.info('ack.updated', { recebidos: updates.length, aplicados: n });
}

// ── Fatia 2 WhatsApp-like: EDIÇÃO de mensagem (cliente edita o que mandou) ──────────
// Baileys 2.3.7: a edição chega como protocolMessage type MESSAGE_EDIT, carregando o id
// da mensagem ORIGINAL (protocolMessage.key.id) + o texto novo (editedMessage). DISTINÇÃO
// do status (Fatia 1): edição TEM corpo novo e NÃO tem data.status mapeável → sem colisão.
// Retorna { id: <id do ALVO>, body: <texto novo> } ou null.
function _detectEdit(body) {
  const data = body && body.data != null ? body.data : body;
  const arr = Array.isArray(data) ? data : [data];
  const novoTexto = (em) => {
    if (!em || typeof em !== 'object') return null;
    const inner = em.message || em;   // editedMessage às vezes embrulha .message
    return inner.conversation
        ?? inner.extendedTextMessage?.text
        ?? inner.imageMessage?.caption
        ?? inner.videoMessage?.caption
        ?? null;
  };
  for (const d of arr) {
    if (!d || typeof d !== 'object') continue;
    const m = d.message || {};
    // protocolMessage MESSAGE_EDIT (forma canônica do Baileys), em vários aninhamentos.
    const proto = m.protocolMessage
               || (m.editedMessage && m.editedMessage.message && m.editedMessage.message.protocolMessage)
               || (m.editedMessage && m.editedMessage.protocolMessage);
    if (proto && /EDIT/i.test(String(proto.type || '')) && proto.editedMessage) {
      const id = (proto.key && proto.key.id) || (d.key && d.key.id) || d.keyId || d.id;
      const novo = novoTexto(proto.editedMessage);
      if (id && novo != null) return { id: String(id), body: String(novo) };
    }
    // forma achatada (algumas versões): message.editedMessage direto, sem protocolMessage.
    if (m.editedMessage && !proto) {
      const id = (d.key && d.key.id) || d.keyId || d.id;
      const novo = novoTexto(m.editedMessage);
      if (id && novo != null) return { id: String(id), body: String(novo) };
    }
  }
  return null;
}

// Aplica a edição na mensagem existente (casa pelo external_message_id = id do alvo).
// Guarda o 1º corpo em original_body (auditoria, idempotente via COALESCE), troca o body
// e seta edited_at. Idempotente (reeditar atualiza de novo). Ignora se não achar a mensagem
// (0 linhas; nunca cria). Só INBOUND casa (outbound tem external_message_id NULL em messages).
async function aplicarEdicao(tenantId, edit, log) {
  const n = await withTenant(tenantId, (c) => c.query(
    `UPDATE messages
        SET original_body = COALESCE(original_body, body),
            body = $2,
            edited_at = now()
      WHERE tenant_id = $1 AND external_message_id = $3`,
    [tenantId, edit.body, edit.id]
  ).then((r) => r.rowCount));
  if (log) log.info('edit.applied', { id: edit.id, aplicados: n });
}

// ── Fatia 3 WhatsApp-like: EXCLUSÃO de mensagem ("apagar para todos") ───────────────
// Baileys 2.3.7 manda a exclusão em DUAS formas — o handler cobre as duas:
//  (1) evento dedicado 'messages.delete' → data.keys:[{id,...}] (ou data.key / array direto);
//  (2) protocolMessage type REVOKE embutido em 'messages.update'/'messages.upsert' →
//      protocolMessage.key.id é o id da mensagem apagada.
// Retorna [ids do ALVO] (dedup). DISTINÇÃO de status/edição: só REVOKE ou o evento delete
// disparam → não colide (status tem data.status; edição tem type EDIT).
function _detectDelete(body) {
  const ev = String(body && body.event || '').toLowerCase();
  const data = body && body.data != null ? body.data : body;
  const arr = Array.isArray(data) ? data : [data];
  const ids = new Set();
  for (const d of arr) {
    if (!d || typeof d !== 'object') continue;
    // (1) evento dedicado messages.delete
    if (ev === 'messages.delete') {
      const keys = Array.isArray(d.keys) ? d.keys : (d.key ? [d.key] : [d]);
      for (const k of keys) { const id = k && (k.id || (k.key && k.key.id)); if (id) ids.add(String(id)); }
    }
    // (2) protocolMessage REVOKE (via update/upsert): id do ALVO em protocolMessage.key.id
    const m = d.message || {};
    const proto = m.protocolMessage
               || (m.editedMessage && m.editedMessage.message && m.editedMessage.message.protocolMessage);
    if (proto && /REVOKE/i.test(String(proto.type || '')) && proto.key && proto.key.id) {
      ids.add(String(proto.key.id));
    }
  }
  return [...ids];
}

// Marca a(s) mensagem(ns) como apagada(s) — SETA deleted_at, NÃO apaga a linha nem o body
// (auditoria; a UI mostra a frase de apagada). Idempotente (COALESCE mantém o 1º timestamp).
// Ignora se não achar (0 linhas; nunca cria). Só INBOUND casa (outbound tem external_message_id NULL).
async function marcarApagada(tenantId, ids, log) {
  if (!ids.length) return;
  const n = await withTenant(tenantId, async (c) => {
    let tot = 0;
    for (const id of ids) {
      const r = await c.query(
        `UPDATE messages SET deleted_at = COALESCE(deleted_at, now())
          WHERE tenant_id = $1 AND external_message_id = $2`,
        [tenantId, id]
      );
      tot += r.rowCount;
    }
    return tot;
  });
  if (log) log.info('delete.applied', { ids: ids.length, aplicados: n });
}

async function handleZapiWebhook(req, res) {
  const tenant = req.tenant;
  const log = req.log;
  const msg = normalizeMessage(req.body);

  // ACK imediato (processamento é assíncrono).
  res.status(200).json({ status: 'ok' });

  // Fatia 3 — EXCLUSÃO (apagar p/ todos): evento dedicado messages.delete OU protocolMessage
  // REVOKE embutido em update/upsert. NÃO é mensagem nova — marca deleted_at e retorna, ANTES
  // de ack/edição/ingestão (evita ingerir um revoke-upsert como mensagem-lixo). No-op se vazio.
  const apagadas = _detectDelete(req.body);
  if (apagadas.length) {
    marcarApagada(tenant.id, apagadas, log).catch((e) => log.warn('delete.unhandled', { error: e.message }));
    return;
  }

  // MESSAGES_UPDATE: NÃO é mensagem nova. Dois sub-casos independentes (sem colisão):
  //  - Fatia 1: status (entregue/lido) → ack na saída (no-op se não houver data.status);
  //  - Fatia 2: edição → troca o body da mensagem + marca "editada" (no-op se não houver).
  if (String(req.body?.event || '').toLowerCase() === 'messages.update') {
    atualizarAckStatus(tenant.id, req.body, log).catch((e) => log.warn('ack.unhandled', { error: e.message }));
    const edit = _detectEdit(req.body);
    if (edit) aplicarEdicao(tenant.id, edit, log).catch((e) => log.warn('edit.unhandled', { error: e.message }));
    return;
  }

  if (!msg || !msg.externalId) {
    log.info('webhook.no_message', { reason: 'unparseable_payload' });
    return;
  }
  // Grupo (@g.us) NUNCA vira lead. ADR-042 E14/B1: em vez de descartar, INGERE a mensagem
  // (kind='GROUP') p/ aparecer na Caixa de Entrada — SEM funil de lead, isolado do 1:1.
  // Só inbound (mensagem de participante); fromMe (nosso envio no grupo) fica p/ o B3.
  if (msg.isGroup) {
    const jid = (req.body && req.body.data && req.body.data.key && req.body.data.key.remoteJid)
      || (req.body && req.body.phone) || null;
    if (!msg.fromMe && jid) {
      engine.captureGroupInbound(tenant.id, String(jid), msg, req.body)
        .catch((e) => log.warn('group.capture_unhandled', { error: e.message }));
    }
    log.info('webhook.group', { captured: !msg.fromMe, from_me: msg.fromMe });
    return;
  }
  if (msg.fromMe) {
    log.info('webhook.skipped', { reason: 'from_me' });
    // Saída da recepção: (1) aprendizado de estilo (staff_outbound_samples) e (2) ADR-030
    // Passo 2 — classificação do estado da bola (shadow). Fire-and-forget: erro aqui nunca
    // afeta o webhook (já respondeu 200) nem o funil.
    const processarSaida = async () => {
      // Áudio de saída: transcreve ANTES de capturar (reusa o inbound) pra a transcrição já
      // entrar como body — o usuário do banco não tem UPDATE em staff_outbound_samples.
      let mediaPendente = false;
      if (msg.media) {
        if (msg.media.kind === 'audio') {
          mediaPendente = true;
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
                const t = await gemini.transcribeAudio({ base64: saved.base64, mimetype: saved.mimetype });
                if (t && t.trim()) { msg.body = t.trim(); mediaPendente = false; }
              }
            }
          } catch (e) { log.warn('saida.transcribe_failed', { error: e.message }); }
        } else {
          mediaPendente = true; // imagem/doc/vídeo de saída: sem texto p/ classificar
        }
      }
      const cap = await staffSamples.captureOutbound(tenant.id, msg, req.body);
      // Só classifica em linha NOVA (rowCount>0) — nunca no eco duplicado (dedup por msg id).
      // ADR-031: reação de saída é capturada (bolha), mas NÃO classifica a bola (meta-sinal).
      if (cap && cap.rowCount > 0 && !msg.reaction) {
        const ident = String(msg.externalId || '').replace(/\D/g, '');
        await engine.classificarSaida(tenant.id, { ident, sampleId: cap.id, body: msg.body, mediaPendente });
      }
    };
    processarSaida().catch((err) => log.warn('saida.unhandled', { error: err.message }));
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
    // CURA (ADR-016): garante que a mídia baixada pouse na linha persistida. Sob carga (Gemini
    // lento) ou entrega duplicada, o insert do funil pode gravar a mensagem ANTES/sem a mídia
    // (dedup ON CONFLICT DO NOTHING) — deixando bolha vazia. COALESCE só preenche o que está
    // nulo; idempotente e barato. Casa por (tenant, external_message_id).
    if (msg.media && (msg.media.url || msg.media.transcription) && msg.externalMessageId) {
      try {
        await withTenant(tenant.id, (c) => c.query(
          `UPDATE messages
              SET media_url            = COALESCE(media_url, $3),
                  media_type           = COALESCE(media_type, $4),
                  media_filename       = COALESCE(media_filename, $5),
                  media_transcription  = COALESCE(media_transcription, $6)
            WHERE tenant_id = $1 AND external_message_id = $2
              AND (media_url IS NULL OR (media_type = 'audio' AND media_transcription IS NULL))`,
          [tenant.id, msg.externalMessageId, msg.media.url || null, msg.media.type || null,
           msg.media.filename || null, msg.media.transcription || null]));
      } catch (e) { log.warn('media.heal_failed', { error: e.message }); }
    }
    // ADR-006+ — resposta automática FORA DO HORÁRIO (a "Janis"). Best-effort: roda DEPOIS de
    // persistir o inbound; nunca bloqueia/derruba a ingestão. Só 1:1 (inbound já filtrado acima).
    autoReply.maybeAutoReply(tenant, { channel: 'whatsapp', externalId: msg.externalId, inboundText: msg.body, contactName: msg.sender })
      .catch((e) => log.warn('autoreply.unhandled', { error: e.message }));
  };
  // Funil de triagem (Portões 0/1/2). Fire-and-forget com captura de erro.
  processar().catch((err) => log.error('engine.unhandled_error', { error: err.message }));
}

router.post('/zapi/:tenantId', authenticateTenant, handleZapiWebhook);

module.exports = router;
// Exportados p/ teste de unidade do parse (sem DB). ADR-031.
module.exports.normalizeMessage = normalizeMessage;
module.exports.detectarMidia = detectarMidia;
module.exports.detectarReacao = detectarReacao;
