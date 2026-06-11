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

async function sendText({ instance, apikey }, number, text) {
  const n = String(number || '').replace(/\D+/g, '');
  try {
    return await req('POST', `/message/sendText/${encodeURIComponent(instance)}`, apikey, { number: n, text });
  } catch (e) {
    // Número não encontrado no WhatsApp (HTTP 400) → tenta a forma com/sem o 9.
    if (e && e.status === 400) {
      const alt = _toggle9BR(n);
      if (alt && alt !== n) {
        return req('POST', `/message/sendText/${encodeURIComponent(instance)}`, apikey, { number: alt, text });
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

module.exports = { status, sendText, pickMessageId, _toggle9BR };
