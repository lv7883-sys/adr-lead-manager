'use strict';
//
// waConteudo.js — TRADUTOR ÚNICO do conteúdo de uma mensagem do WhatsApp (paridade com o WhatsApp, etapa 3).
//
// Antes o Regente só entendia texto, foto, vídeo, áudio, documento, figurinha e reação: enquete, lista,
// botões, localização, contato, evento, convite de grupo, mensagem temporária, citação feita no celular,
// menção e "encaminhada" sumiam ou viravam bolha vazia (2.954 saídas vazias na importação). Webhook e
// importação de histórico passam a descrever a mensagem por AQUI — uma régua só.
//
// descrever(message) -> {
//   inner,          // a mensagem de verdade, sem embrulhos (temporária, visualização única, enviada por outro aparelho)
//   texto,          // o texto legível da bolha (null quando o tipo é mídia e o texto vem da legenda)
//   conteudo,       // dados estruturados p/ a tela desenhar o cartão (null p/ texto simples)
//   semConteudo,    // true = não é bolha (protocolo, distribuição de chave, voto de enquete, álbum...)
// }
//

// associatedChildMessage = cada foto/vídeo de um ÁLBUM: embrulho com a mídia dentro (antes virava bolha vazia).
const _EMBRULHOS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'deviceSentMessage', 'lottieStickerMessage',
  'associatedChildMessage'];

// Tipo da protocolMessage. O webhook traz o nome ('MESSAGE_EDIT'); o histórico (findMessages) traz o NÚMERO
// do enum (14) — por isso edições e apagamentos do histórico passavam batido e viravam bolha vazia.
const _PROTO = { 0: 'revogacao', 3: 'temporarias', 14: 'edicao', REVOKE: 'revogacao', EPHEMERAL_SETTING: 'temporarias', MESSAGE_EDIT: 'edicao' };
function tipoProtocolo(p) {
  if (!p || typeof p !== 'object' || p.type == null) return null;
  return _PROTO[String(p.type).toUpperCase()] || null;
}

function desembrulhar(message) {
  let m = message || {};
  const flags = { temporaria: false, visualizacaoUnica: false };
  for (let i = 0; i < 6; i++) {
    const nome = _EMBRULHOS.find((k) => m[k] && m[k].message);
    if (!nome) break;
    if (nome === 'ephemeralMessage') flags.temporaria = true;
    if (nome.startsWith('viewOnce')) flags.visualizacaoUnica = true;
    m = m[nome].message;
  }
  return { inner: m, ...flags };
}

// contextInfo mora dentro do submessage do tipo (extendedTextMessage.contextInfo, imageMessage.contextInfo...)
function _contextInfo(inner) {
  if (!inner || typeof inner !== 'object') return null;
  for (const [k, v] of Object.entries(inner)) {
    if (k === 'messageContextInfo') continue;
    if (v && typeof v === 'object' && v.contextInfo) return v.contextInfo;
  }
  return null;
}

function contexto(message) {
  const { inner } = desembrulhar(message);
  const ci = _contextInfo(inner) || {};
  const mencoes = Array.isArray(ci.mentionedJid) ? ci.mentionedJid.filter(Boolean).map(String) : [];
  const out = {};
  if (ci.stanzaId) out.citadaId = String(ci.stanzaId);
  if (ci.participant) out.citadaAutor = String(ci.participant);
  if (mencoes.length) out.mencoes = mencoes;
  if (ci.isForwarded) { out.encaminhada = true; if (Number(ci.forwardingScore) >= 5) out.encaminhadaComFrequencia = true; }
  return out;
}

const _num = (v) => (v == null ? null : Number(v));
const _s = (v) => (v == null ? '' : String(v)).trim();

// vCard -> { nome, telefones: [{ numero, wa }] }
function _lerVcard(vcard, displayName) {
  const linhas = String(vcard || '').split(/\r?\n/);
  const fn = linhas.find((l) => /^FN[:;]/i.test(l));
  const nome = _s(displayName) || (fn ? _s(fn.split(':').slice(1).join(':')) : '');
  const telefones = linhas.filter((l) => /^(item\d+\.)?TEL/i.test(l)).map((l) => {
    const wa = /waid=(\d+)/i.exec(l);
    return { numero: _s(l.split(':').slice(1).join(':')), wa: wa ? wa[1] : null };
  }).filter((t) => t.numero);
  return { nome, telefones };
}

const _dataHora = (seg) => {
  const n = _num(seg);
  if (!n) return null;
  return new Date(n * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

function _botoesNativos(nfm) {
  const btns = (nfm && Array.isArray(nfm.buttons)) ? nfm.buttons : [];
  return btns.map((b) => {
    try { const p = JSON.parse(b.buttonParamsJson || '{}'); return _s(p.display_text || p.title || b.name); } catch { return _s(b.name); }
  }).filter(Boolean);
}

// Descreve UM message já sem embrulhos. Mídia (imagem/vídeo/áudio/documento/figurinha) e reação ficam com
// quem já trata (detectarMidia/detectarReacao no webhook): aqui só o que não é mídia.
function _descreverInner(m) {
  if (m.conversation != null) return { texto: String(m.conversation) };
  // Aviso de sistema "mensagens temporárias" (o único protocolo que o WhatsApp mostra na conversa).
  if (m.protocolMessage && tipoProtocolo(m.protocolMessage) === 'temporarias') {
    const s = _num(m.protocolMessage.ephemeralExpiration) || 0;
    const prazo = s >= 7776000 ? '90 dias' : s >= 604800 ? '7 dias' : s >= 86400 ? '24 horas' : s ? Math.round(s / 3600) + ' horas' : '';
    return { texto: prazo ? `⏱ Mensagens temporárias ativadas (${prazo})` : '⏱ Mensagens temporárias desativadas',
      conteudo: { tipo: 'sistema', evento: 'temporarias', segundos: s } };
  }
  if (m.productMessage) {
    const p = m.productMessage.product || {};
    const preco = _num(p.priceAmount1000) != null && p.currencyCode ? ` — ${(_num(p.priceAmount1000) / 1000).toLocaleString('pt-BR', { style: 'currency', currency: p.currencyCode })}` : '';
    return { texto: `🛍 Produto: ${_s(p.title) || 'item do catálogo'}${preco}${_s(m.productMessage.body) ? '\n' + _s(m.productMessage.body) : ''}` };
  }
  if (m.orderMessage) {
    const o = m.orderMessage; const n = _num(o.itemCount);
    return { texto: `🧾 Pedido${n ? ` (${n} ${n === 1 ? 'item' : 'itens'})` : ''}${_s(o.orderTitle) ? ': ' + _s(o.orderTitle) : ''}${_s(o.message) ? '\n' + _s(o.message) : ''}` };
  }
  if (m.extendedTextMessage) {
    const e = m.extendedTextMessage;
    const conteudo = (e.matchedText || e.title) ? { tipo: 'link', url: _s(e.matchedText || e.canonicalUrl), titulo: _s(e.title), descricao: _s(e.description) } : null;
    return { texto: e.text != null ? String(e.text) : null, conteudo };
  }
  if (m.locationMessage) {
    const l = m.locationMessage; const lat = _num(l.degreesLatitude); const lng = _num(l.degreesLongitude);
    const rotulo = [_s(l.name), _s(l.address)].filter(Boolean).join(' — ');
    return { texto: `📍 Localização${rotulo ? ': ' + rotulo : ''}`,
      conteudo: { tipo: 'localizacao', lat, lng, nome: _s(l.name), endereco: _s(l.address), url: lat != null && lng != null ? `https://maps.google.com/?q=${lat},${lng}` : _s(l.url) } };
  }
  if (m.liveLocationMessage) {
    const l = m.liveLocationMessage; const lat = _num(l.degreesLatitude); const lng = _num(l.degreesLongitude);
    return { texto: `📍 Localização em tempo real${_s(l.caption) ? ': ' + _s(l.caption) : ''}`,
      conteudo: { tipo: 'localizacao', aoVivo: true, lat, lng, nome: _s(l.caption), endereco: '', url: lat != null && lng != null ? `https://maps.google.com/?q=${lat},${lng}` : '' } };
  }
  if (m.contactMessage || m.contactsArrayMessage) {
    const lista = m.contactMessage ? [m.contactMessage] : (m.contactsArrayMessage.contacts || []);
    const contatos = lista.map((c) => _lerVcard(c.vcard, c.displayName));
    const nomes = contatos.map((c) => c.nome || (c.telefones[0] && c.telefones[0].numero) || 'contato').join(', ');
    return { texto: `👤 Contato${contatos.length > 1 ? 's' : ''}: ${nomes}`, conteudo: { tipo: 'contato', contatos } };
  }
  const poll = m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3 || m.pollCreationMessageV5;
  if (poll) {
    const opcoes = (poll.options || []).map((o) => _s(o.optionName)).filter(Boolean);
    return { texto: `📊 Enquete: ${_s(poll.name)}\n${opcoes.map((o) => '• ' + o).join('\n')}`,
      conteudo: { tipo: 'enquete', pergunta: _s(poll.name), opcoes, multipla: Number(poll.selectableOptionsCount) !== 1, votos: {} } };
  }
  if (m.listMessage) {
    const l = m.listMessage;
    const secoes = (l.sections || []).map((s) => ({ titulo: _s(s.title), linhas: (s.rows || []).map((r) => ({ id: _s(r.rowId), titulo: _s(r.title), descricao: _s(r.description) })) }));
    return { texto: [_s(l.title), _s(l.description)].filter(Boolean).join('\n') || `Lista: ${_s(l.buttonText)}`,
      conteudo: { tipo: 'lista', titulo: _s(l.title), descricao: _s(l.description), botao: _s(l.buttonText), rodape: _s(l.footerText), secoes } };
  }
  if (m.listResponseMessage) {
    const r = m.listResponseMessage;
    return { texto: `✅ ${_s(r.title) || _s(r.singleSelectReply && r.singleSelectReply.selectedRowId)}`,
      conteudo: { tipo: 'resposta', escolhido: _s(r.title), id: _s(r.singleSelectReply && r.singleSelectReply.selectedRowId) } };
  }
  if (m.buttonsMessage) {
    const b = m.buttonsMessage;
    const botoes = (b.buttons || []).map((x) => _s(x.buttonText && x.buttonText.displayText)).filter(Boolean);
    return { texto: _s(b.contentText) || botoes.join(' | '), conteudo: { tipo: 'botoes', texto: _s(b.contentText), rodape: _s(b.footerText), botoes } };
  }
  if (m.buttonsResponseMessage) {
    const r = m.buttonsResponseMessage;
    return { texto: `✅ ${_s(r.selectedDisplayText) || _s(r.selectedButtonId)}`, conteudo: { tipo: 'resposta', escolhido: _s(r.selectedDisplayText), id: _s(r.selectedButtonId) } };
  }
  const tpl = m.templateMessage && (m.templateMessage.hydratedTemplate || m.templateMessage.hydratedFourRowTemplate);
  if (tpl) {
    const botoes = (tpl.hydratedButtons || []).map((x) => _s((x.quickReplyButton || x.urlButton || x.callButton || {}).displayText)).filter(Boolean);
    return { texto: _s(tpl.hydratedContentText) || botoes.join(' | '), conteudo: { tipo: 'botoes', texto: _s(tpl.hydratedContentText), rodape: _s(tpl.hydratedFooterText), botoes } };
  }
  if (m.templateButtonReplyMessage) {
    const r = m.templateButtonReplyMessage;
    return { texto: `✅ ${_s(r.selectedDisplayText) || _s(r.selectedId)}`, conteudo: { tipo: 'resposta', escolhido: _s(r.selectedDisplayText), id: _s(r.selectedId) } };
  }
  if (m.interactiveMessage) {
    const i = m.interactiveMessage;
    const texto = _s(i.body && i.body.text); const botoes = _botoesNativos(i.nativeFlowMessage);
    return { texto: texto || botoes.join(' | ') || null, conteudo: { tipo: 'botoes', texto, rodape: _s(i.footer && i.footer.text), botoes } };
  }
  if (m.interactiveResponseMessage) {
    const r = m.interactiveResponseMessage; let escolhido = _s(r.body && r.body.text);
    if (!escolhido && r.nativeFlowResponseMessage) { try { const p = JSON.parse(r.nativeFlowResponseMessage.paramsJson || '{}'); escolhido = _s(p.display_text || p.title || p.id); } catch { /* */ } }
    return { texto: `✅ ${escolhido || 'resposta'}`, conteudo: { tipo: 'resposta', escolhido } };
  }
  if (m.eventMessage) {
    const e = m.eventMessage; const quando = _dataHora(e.startTime); const local = _s(e.location && (e.location.name || e.location.address));
    return { texto: `📅 Evento: ${_s(e.name)}${quando ? ' — ' + quando : ''}${local ? ' — ' + local : ''}${e.isCanceled ? ' (cancelado)' : ''}`,
      conteudo: { tipo: 'evento', nome: _s(e.name), descricao: _s(e.description), inicio: _num(e.startTime) ? _num(e.startTime) * 1000 : null, local, cancelado: !!e.isCanceled } };
  }
  if (m.groupInviteMessage) {
    const g = m.groupInviteMessage;
    return { texto: `👥 Convite para o grupo ${_s(g.groupName)}${_s(g.caption) ? '\n' + _s(g.caption) : ''}`,
      conteudo: { tipo: 'convite_grupo', grupo: _s(g.groupName), texto: _s(g.caption), link: g.inviteCode ? `https://chat.whatsapp.com/${g.inviteCode}` : '' } };
  }
  if (m.pinInChatMessage) {
    const fixou = Number(m.pinInChatMessage.type) !== 2 && String(m.pinInChatMessage.type) !== 'UNPIN_FOR_ALL';
    return { texto: fixou ? '📌 Mensagem fixada' : 'Mensagem desafixada', conteudo: { tipo: 'sistema', evento: fixou ? 'fixou' : 'desafixou' } };
  }
  const call = m.callLogMesssage || m.callLogMessage;
  if (call) {
    const video = !!call.isVideo; const perdida = /MISSED|0/i.test(String(call.callOutcome ?? ''));
    const dur = _num(call.durationSecs);
    return { texto: `📞 Chamada de ${video ? 'vídeo' : 'voz'}${perdida ? ' perdida' : ''}${dur ? ` (${Math.floor(dur / 60)}min${String(dur % 60).padStart(2, '0')}s)` : ''}`,
      conteudo: { tipo: 'chamada', video, perdida, duracao: dur } };
  }
  if (m.requestPhoneNumberMessage) return { texto: '📱 Pedido de número de telefone', conteudo: { tipo: 'sistema', evento: 'pedido_telefone' } };
  return null;
}

// Tipos que NÃO são bolha no WhatsApp: são eventos sobre outras mensagens ou metadado de protocolo.
const _SEM_BOLHA = ['protocolMessage', 'senderKeyDistributionMessage', 'keepInChatMessage', 'pollUpdateMessage', 'encReactionMessage',
  'albumMessage', 'secretEncryptedMessage', 'encEventResponseMessage', 'messageHistoryBundle', 'placeholderMessage'];
const _MIDIA = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'documentWithCaptionMessage', 'stickerMessage', 'ptvMessage', 'reactionMessage'];

function descrever(message) {
  const { inner, temporaria, visualizacaoUnica } = desembrulhar(message);
  const ctx = contexto(message);
  const base = _descreverInner(inner) || { texto: null, conteudo: null };
  const chaves = Object.keys(inner || {}).filter((k) => k !== 'messageContextInfo');
  const ehMidia = chaves.some((k) => _MIDIA.includes(k));
  const semConteudo = !ehMidia && base.texto == null && (chaves.length === 0 || chaves.every((k) => _SEM_BOLHA.includes(k)));
  let conteudo = base.conteudo ? { ...base.conteudo } : null;
  const extras = { ...ctx };
  if (temporaria) extras.temporaria = true;
  if (visualizacaoUnica) extras.visualizacaoUnica = true;
  if (Object.keys(extras).length) conteudo = { ...(conteudo || { tipo: 'texto' }), contexto: extras };
  return { inner, texto: base.texto, conteudo, semConteudo };
}

module.exports = { descrever, desembrulhar, contexto, tipoProtocolo, _lerVcard };
