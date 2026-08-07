'use strict';
//
// evolution.js — cliente HTTP da Evolution API (porta do lib/evolution.js do Scheduler).
//
// Stateless por chamada: cada função recebe { instance, apikey }, onde `apikey` é o
// token da instância DO TENANT (não a chave global). EVOLUTION_URL é global (env).
// O LM não cria/deleta instâncias — só consulta status e envia texto —, então a
// chave global da Evolution não é necessária aqui.
//
const URL_BASE = (process.env.EVOLUTION_URL || '').replace(/\/+$/, '');

async function req(method, path, apikey, body) {
  if (!URL_BASE) throw new Error('EVOLUTION_URL não configurado');
  const headers = { apikey };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${URL_BASE}${path}`, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const e = new Error(`Evolution ${method} ${path} → HTTP ${r.status}`);
    e.status = r.status; e.body = data;
    throw e;
  }
  return data;
}

function pickState(d) {
  if (!d) return null;
  if (typeof d === 'string') return d;
  if (d.state) return d.state;
  if (d.instance && d.instance.state) return d.instance.state;
  if (d.connectionStatus) return d.connectionStatus;
  return null;
}

function pickNumber(d) {
  if (!d) return null;
  const owner =
    (d.instance && (d.instance.ownerJid || d.instance.owner)) ||
    d.ownerJid || d.owner || (d.user && d.user.id);
  if (!owner) return null;
  const m = String(owner).match(/(\d+)/);
  return m ? m[1] : null;
}

// Alterna o 9º dígito de um celular BR (55 + DDD + número). O WhatsApp guarda alguns
// números com o "9" e outros sem; quando o envio falha por número não encontrado,
// vale tentar a outra forma. Retorna a variante ou null.
function _toggle9BR(n) {
  const d = String(n || '').replace(/\D+/g, '');
  if (!d.startsWith('55')) return null;
  const rest = d.slice(2);                            // DDD + número local
  if (rest.length === 11 && rest[2] === '9') {        // tem o 9 → remove
    return '55' + rest.slice(0, 2) + rest.slice(3);
  }
  if (rest.length === 10 && /[6-9]/.test(rest[2])) {  // sem o 9 (celular) → adiciona
    return '55' + rest.slice(0, 2) + '9' + rest.slice(2);
  }
  return null;
}

async function status({ instance, apikey }) {
  const d = await req('GET', `/instance/connectionState/${encodeURIComponent(instance)}`, apikey);
  return { state: pickState(d), number: pickNumber(d), raw: d };
}

// `quoted` (opcional) = citação do WhatsApp: { key: { id, remoteJid, fromMe, ... } }.
// Incluído no corpo SÓ quando presente — sem `quoted`, o comportamento é idêntico ao anterior.
async function sendText({ instance, apikey }, number, text, quoted) {
  const corpo = (num) => ({ number: num, text, ...(quoted ? { quoted } : {}) });
  // ADR-042 B3 — GRUPO/comunidade: o jid @g.us vai INTEIRO no campo `number` (sem strip de
  // dígitos nem toggle-9, que valem só p/ telefone individual). A Evolution roteia pelo jid.
  if (/@g\.us$/i.test(String(number || ''))) {
    return await req('POST', `/message/sendText/${encodeURIComponent(instance)}`, apikey, corpo(String(number)));
  }
  const n = String(number || '').replace(/\D+/g, '');
  try {
    return await req('POST', `/message/sendText/${encodeURIComponent(instance)}`, apikey, corpo(n));
  } catch (e) {
    // Número não encontrado no WhatsApp (HTTP 400) → tenta a forma com/sem o 9.
    if (e && e.status === 400) {
      const alt = _toggle9BR(n);
      if (alt && alt !== n) {
        return req('POST', `/message/sendText/${encodeURIComponent(instance)}`, apikey, corpo(alt));
      }
    }
    throw e;
  }
}

// Extrai o id da mensagem do WhatsApp da resposta do sendText (pra correlacionar com
// o webhook de status de entrega, se/quando o LM consumir isso).
function pickMessageId(d) {
  if (!d || typeof d !== 'object') return null;
  return (d.key && d.key.id)
      || d.messageId || d.id
      || (d.message && d.message.key && d.message.key.id)
      || null;
}

// ADR-016 — baixa a mídia de uma mensagem recebida, em base64. `message` é o objeto
// da mensagem da Evolution (com a key). Devolve { base64, mimetype, fileName }.
async function getBase64FromMediaMessage({ instance, apikey }, message) {
  const d = await req('POST', `/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`, apikey, { message });
  return {
    base64: d && (d.base64 || d.media || (d.data && d.data.base64)) || null,
    mimetype: d && (d.mimetype || d.mimeType || (d.data && d.data.mimetype)) || null,
    fileName: d && (d.fileName || d.filename || (d.data && d.data.fileName)) || null,
  };
}

// ADR-016 P1 — envia mídia (base64) ao lead. `opts` = { mediatype, mimetype, media
// (base64), fileName, caption? }. Mesmo retry 9-dígitos do sendText.
async function sendMedia({ instance, apikey }, number, opts) {
  const corpo = (num) => ({
    number: num,
    mediatype: opts.mediatype,
    mimetype: opts.mimetype,
    media: opts.media,
    fileName: opts.fileName,
    ...(opts.caption ? { caption: opts.caption } : {}),
  });
  // ADR-042 B3 — GRUPO: jid @g.us inteiro no `number` (sem strip/toggle-9).
  if (/@g\.us$/i.test(String(number || ''))) {
    return await req('POST', `/message/sendMedia/${encodeURIComponent(instance)}`, apikey, corpo(String(number)));
  }
  const n = String(number || '').replace(/\D+/g, '');
  try {
    return await req('POST', `/message/sendMedia/${encodeURIComponent(instance)}`, apikey, corpo(n));
  } catch (e) {
    if (e && e.status === 400) {
      const alt = _toggle9BR(n);
      if (alt && alt !== n) return req('POST', `/message/sendMedia/${encodeURIComponent(instance)}`, apikey, corpo(alt));
    }
    throw e;
  }
}

// ADR-042 — NOTA DE VOZ (ptt) gravada no navegador. A Evolution converte o áudio (webm/opus
// do browser) p/ ogg/opus ptt server-side, então vira uma "mensagem de voz" de verdade no
// WhatsApp (não um anexo). `audioBase64` = base64 cru do áudio gravado. Mesmo tratamento de
// jid @g.us (grupo) / dígitos+toggle-9 (1:1) do sendText.
async function sendWhatsAppAudio({ instance, apikey }, number, audioBase64) {
  const corpo = (num) => ({ number: num, audio: audioBase64 });
  if (/@g\.us$/i.test(String(number || ''))) {
    return await req('POST', `/message/sendWhatsAppAudio/${encodeURIComponent(instance)}`, apikey, corpo(String(number)));
  }
  const n = String(number || '').replace(/\D+/g, '');
  try {
    return await req('POST', `/message/sendWhatsAppAudio/${encodeURIComponent(instance)}`, apikey, corpo(n));
  } catch (e) {
    if (e && e.status === 400) {
      const alt = _toggle9BR(n);
      if (alt && alt !== n) return req('POST', `/message/sendWhatsAppAudio/${encodeURIComponent(instance)}`, apikey, corpo(alt));
    }
    throw e;
  }
}

// Fatia AÇÃO-1 — APAGAR para todos (deleteMessageForEveryone). `key` = a key do WhatsApp
// da mensagem NOSSA: { id, remoteJid, fromMe:true, participant? }. O body É a key crua
// (a Evolution 2.3.7 faz sendMessage(key.remoteJid, { delete: key })). Best-effort: NÃO
// estoura — devolve { ok:false, error } p/ a rota traduzir (ex.: janela do WhatsApp expirada).
async function deleteMessage({ instance, apikey }, key) {
  try {
    const d = await req('DELETE', `/chat/deleteMessageForEveryone/${encodeURIComponent(instance)}`, apikey, key);
    return { ok: true, raw: d };
  } catch (e) {
    const b = e && e.body;
    const detail = (b && (b.response?.message || b.message || b.error))
      || (e && e.message) || 'erro ao apagar';
    return { ok: false, error: Array.isArray(detail) ? detail.join('; ') : String(detail), status: e && e.status };
  }
}

// Fatia AÇÃO-2 — EDITAR nossa mensagem (updateMessage). `key` = a key do WhatsApp da NOSSA
// mensagem { id, remoteJid, fromMe:true }; `number` = telefone do destinatário (deve casar
// com key.remoteJid); `text` = texto novo. A Evolution valida a janela de 15 min e text-only
// server-side → fora da janela volta como erro. Best-effort: NÃO estoura — { ok:false, error }.
async function editMessage({ instance, apikey }, key, number, text) {
  const n = String(number || '').replace(/\D+/g, '');
  try {
    const d = await req('POST', `/chat/updateMessage/${encodeURIComponent(instance)}`, apikey, { number: n, key, text });
    return { ok: true, raw: d };
  } catch (e) {
    const b = e && e.body;
    const detail = (b && (b.response?.message || b.message || b.error))
      || (e && e.message) || 'erro ao editar';
    return { ok: false, error: Array.isArray(detail) ? detail.join('; ') : String(detail), status: e && e.status };
  }
}

// Reagir a uma mensagem (👍 etc.). `key` = key do WhatsApp da mensagem-alvo (inbound do
// cliente OU outbound nossa); `reaction` = emoji ('' remove a reação). Best-effort: { ok, error }.
async function sendReaction({ instance, apikey }, key, reaction) {
  try {
    const d = await req('POST', `/message/sendReaction/${encodeURIComponent(instance)}`, apikey, { key, reaction });
    return { ok: true, raw: d };
  } catch (e) {
    const b = e && e.body;
    const detail = (b && (b.response?.message || b.message || b.error)) || (e && e.message) || 'erro ao reagir';
    return { ok: false, error: Array.isArray(detail) ? detail.join('; ') : String(detail), status: e && e.status };
  }
}

// ADR-042 (badge "não-lidas") — lista as conversas da instância (POST /chat/findChats).
// READ-ONLY. Na Evolution v2 cada item traz o unread por conversa — cujo nome de campo VARIA
// por versão (unreadCount | unreadMessages) — e esse número já reflete leituras de TODOS os
// aparelhos (celular + WhatsApp Web), servindo de fonte de verdade p/ o inbox. `body` opcional
// = filtro/paginação conforme a versão. Normaliza o retorno p/ sempre devolver um array.
async function findChats({ instance, apikey }, body = {}) {
  const d = await req('POST', `/chat/findChats/${encodeURIComponent(instance)}`, apikey, body);
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.chats)) return d.chats;
  if (d && Array.isArray(d.data)) return d.data;
  return [];
}

// Reconexão (backfill do histórico) — lê UMA PÁGINA das mensagens de uma conversa do STORE da
// própria Evolution (POST /chat/findMessages). READ-ONLY. Diferente do webhook (push, ao vivo),
// aqui PUXAMOS: quando a instância volta de uma queda, o Baileys recebe via history-sync as
// mensagens trocadas offline (inclusive as respostas da recepção feitas em OUTRO aparelho /
// WhatsApp Web, fromMe=true) — que a Evolution NÃO reencaminha como messages.upsert. Elas ficam
// no store da Evolution e só chegam ao Regente por este pull. `remoteJid` = jid do contato
// (…@s.whatsapp.net). O caller PAGINA (page 1..N) para trazer o HISTÓRICO INTEIRO, não só o fim.
//
// O formato do body e do retorno VARIA por versão da Evolution v2 — mandamos a forma canônica
// ({ where: { key: { remoteJid } }, page, offset }) e normalizamos o retorno para SEMPRE devolver
// { records, page, pages, total, pageSize }: `records` = array de registros crus (cada um com
// .key/.message/.messageTimestamp); `pages`/`total` = metadados de paginação quando a versão os
// expõe (null quando não), p/ o caller saber quando parar.
async function findMessages({ instance, apikey }, remoteJid, opts = {}) {
  const page = opts.page || 1;
  const pageSize = opts.pageSize || 100;
  const body = { where: { key: { remoteJid: String(remoteJid) } }, page, offset: pageSize };
  const d = await req('POST', `/chat/findMessages/${encodeURIComponent(instance)}`, apikey, body);
  let records = [];
  let pages = null; let total = null; let currentPage = page;
  if (Array.isArray(d)) {
    records = d;
  } else if (d && d.messages && Array.isArray(d.messages.records)) {   // v2 paginado
    records = d.messages.records;
    pages = d.messages.pages != null ? Number(d.messages.pages) : null;
    total = d.messages.total != null ? Number(d.messages.total) : null;
    currentPage = d.messages.currentPage != null ? Number(d.messages.currentPage) : page;
  } else if (d && Array.isArray(d.records)) {
    records = d.records;
    pages = d.pages != null ? Number(d.pages) : null;
    total = d.total != null ? Number(d.total) : null;
  } else if (d && Array.isArray(d.messages)) {
    records = d.messages;
  } else if (d && Array.isArray(d.data)) {
    records = d.data;
  }
  return { records, page: currentPage, pages, total, pageSize };
}

module.exports = { status, sendText, sendMedia, sendWhatsAppAudio, sendReaction, pickMessageId, getBase64FromMediaMessage, deleteMessage, editMessage, findChats, findMessages, _toggle9BR };
