'use strict';
//
// media.js — ADR-016 P0. Baixa a mídia recebida (Evolution), grava no disco e
// devolve os metadados pra persistir em messages. Best-effort (chamador trata erro).
//
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const evolution = require('./evolution');
const logger = require('./logger');

const MEDIA_ROOT = process.env.MEDIA_ROOT || '/app/uploads';

const EXT_POR_MIME = {
  'audio/ogg': 'ogg', 'audio/ogg; codecs=opus': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/3gpp': '3gp', 'video/quicktime': 'mov',
  'application/pdf': 'pdf',
};
function extDe(mimetype, filename) {
  const base = String(mimetype || '').split(';')[0].trim().toLowerCase();
  if (EXT_POR_MIME[base]) return EXT_POR_MIME[base];
  const m = String(filename || '').match(/\.([a-z0-9]{1,8})$/i);
  if (m) return m[1].toLowerCase();
  if (base.startsWith('audio/')) return 'ogg';
  if (base.startsWith('image/')) return 'jpg';
  if (base.startsWith('video/')) return 'mp4';
  return 'bin';
}

// Baixa a mídia e grava em MEDIA_ROOT/{tenantId}/{uuid}.{ext}.
// Retorna { media_url, media_type, media_filename, diskPath, mimetype, base64 } ou null.
async function salvarMidia({ tenantId, instance, apikey, media }) {
  try {
    // A Evolution precisa do envelope com a key (só o conteúdo data.message dá HTTP 400).
    const envelope = { key: media.messageKey, message: media.rawMessage };
    const dl = await evolution.getBase64FromMediaMessage({ instance, apikey }, envelope);
    if (!dl || !dl.base64) {
      logger.warn('media.no_base64', { tenant_id: tenantId, kind: media.kind });
      return null;
    }
    const mimetype = dl.mimetype || media.mimetype;
    const ext = extDe(mimetype, dl.fileName || media.filename);
    const uuid = crypto.randomUUID();
    const dir = path.join(MEDIA_ROOT, tenantId);
    fs.mkdirSync(dir, { recursive: true });
    const diskPath = path.join(dir, `${uuid}.${ext}`);
    fs.writeFileSync(diskPath, Buffer.from(dl.base64, 'base64'));
    return {
      media_url: `/media/${tenantId}/${uuid}.${ext}`,
      media_type: media.kind,
      media_filename: media.filename || dl.fileName || null,
      diskPath,
      mimetype,
      base64: dl.base64,
    };
  } catch (err) {
    logger.warn('media.save_failed', { tenant_id: tenantId, kind: media && media.kind, error: err.message });
    return null;
  }
}

// Resolve o caminho em disco a partir de tenant_id + filename, com guarda anti
// path-traversal. Retorna o caminho absoluto ou null se inválido/inexistente.
function resolverArquivo(tenantId, filename) {
  if (!/^[0-9a-fA-F-]{36}$/.test(String(tenantId || ''))) return null;
  if (!/^[\w-]+\.[a-z0-9]{1,8}$/i.test(String(filename || ''))) return null; // sem barras/..
  const full = path.join(MEDIA_ROOT, tenantId, filename);
  const base = path.join(MEDIA_ROOT, tenantId) + path.sep;
  if (!full.startsWith(base)) return null;
  return fs.existsSync(full) ? full : null;
}

const CONTENT_TYPE = {
  ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', '3gp': 'video/3gpp', mov: 'video/quicktime', pdf: 'application/pdf',
};
function contentType(filename) {
  const m = String(filename || '').match(/\.([a-z0-9]+)$/i);
  return (m && CONTENT_TYPE[m[1].toLowerCase()]) || 'application/octet-stream';
}

// ADR-016 P1 — tipo de mídia a partir do mimetype.
function tipoDeMime(mimetype) {
  const b = String(mimetype || '').split(';')[0].trim().toLowerCase();
  if (b.startsWith('audio/')) return 'audio';
  if (b.startsWith('image/')) return 'image';
  if (b.startsWith('video/')) return 'video';
  return 'document';
}

// ADR-016 P1 — grava um Buffer (upload da recepção) no volume. Retorna
// { media_url, media_type, diskPath, base64 }.
function salvarBuffer({ tenantId, buffer, mimetype, filename }) {
  const ext = extDe(mimetype, filename);
  const uuid = crypto.randomUUID();
  const dir = path.join(MEDIA_ROOT, tenantId);
  fs.mkdirSync(dir, { recursive: true });
  const diskPath = path.join(dir, `${uuid}.${ext}`);
  fs.writeFileSync(diskPath, buffer);
  return {
    media_url: `/media/${tenantId}/${uuid}.${ext}`,
    media_type: tipoDeMime(mimetype),
    diskPath,
    base64: buffer.toString('base64'),
  };
}

module.exports = { salvarMidia, salvarBuffer, tipoDeMime, resolverArquivo, contentType, MEDIA_ROOT };
