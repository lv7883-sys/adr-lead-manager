'use strict';
// waConteudo.test.js — tradutor de conteúdo do WhatsApp e voto de enquete (sem DB). Paridade, etapa 3.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { descrever } = require('../src/waConteudo');
const enquete = require('../src/waEnquete');

test('texto simples e texto com prévia de link', () => {
  assert.deepEqual(descrever({ conversation: 'oi' }), { inner: { conversation: 'oi' }, texto: 'oi', conteudo: null, semConteudo: false });
  const d = descrever({ extendedTextMessage: { text: 'olha https://adr.com.br', matchedText: 'https://adr.com.br', title: 'Academia', description: 'Aulas' } });
  assert.equal(d.texto, 'olha https://adr.com.br');
  assert.deepEqual(d.conteudo, { tipo: 'link', url: 'https://adr.com.br', titulo: 'Academia', descricao: 'Aulas' });
});

test('mensagem TEMPORÁRIA: o texto embrulhado não se perde', () => {
  const d = descrever({ ephemeralMessage: { message: { extendedTextMessage: { text: 'some em 7 dias' } } } });
  assert.equal(d.texto, 'some em 7 dias');
  assert.equal(d.conteudo.contexto.temporaria, true);
});

test('citação feita no celular, menção e encaminhada vêm do contextInfo', () => {
  const d = descrever({ extendedTextMessage: { text: '@5519999990001 viu?', contextInfo: {
    stanzaId: 'ABC123', participant: '5519999990002@s.whatsapp.net', mentionedJid: ['5519999990001@s.whatsapp.net'], isForwarded: true, forwardingScore: 6 } } });
  assert.deepEqual(d.conteudo.contexto, { citadaId: 'ABC123', citadaAutor: '5519999990002@s.whatsapp.net',
    mencoes: ['5519999990001@s.whatsapp.net'], encaminhada: true, encaminhadaComFrequencia: true });
});

test('localização e localização em tempo real', () => {
  const d = descrever({ locationMessage: { degreesLatitude: -22.97, degreesLongitude: -46.99, name: 'Academia do Rock', address: 'Rua X, 100' } });
  assert.equal(d.texto, '📍 Localização: Academia do Rock — Rua X, 100');
  assert.equal(d.conteudo.url, 'https://maps.google.com/?q=-22.97,-46.99');
  assert.equal(descrever({ liveLocationMessage: { degreesLatitude: 1, degreesLongitude: 2 } }).conteudo.aoVivo, true);
});

test('cartão de contato (vCard) com número do WhatsApp', () => {
  const vcard = 'BEGIN:VCARD\nVERSION:3.0\nFN:Maria Souza\nitem1.TEL;waid=5519999990003:+55 19 99999-0003\nEND:VCARD';
  const d = descrever({ contactMessage: { displayName: 'Maria Souza', vcard } });
  assert.equal(d.texto, '👤 Contato: Maria Souza');
  assert.deepEqual(d.conteudo.contatos, [{ nome: 'Maria Souza', telefones: [{ numero: '+55 19 99999-0003', wa: '5519999990003' }] }]);
});

test('enquete (V3), lista, resposta de lista, botões e resposta de botão', () => {
  const e = descrever({ pollCreationMessageV3: { name: 'Melhor dia?', options: [{ optionName: 'Sábado' }, { optionName: 'Domingo' }], selectableOptionsCount: 1 } });
  assert.equal(e.conteudo.tipo, 'enquete'); assert.deepEqual(e.conteudo.opcoes, ['Sábado', 'Domingo']); assert.equal(e.conteudo.multipla, false);
  assert.match(e.texto, /^📊 Enquete: Melhor dia\?\n• Sábado\n• Domingo$/);
  const l = descrever({ listMessage: { title: 'Horários', description: 'Escolha', buttonText: 'Ver', sections: [{ title: 'Manhã', rows: [{ rowId: 'm1', title: '9h' }] }] } });
  assert.equal(l.conteudo.secoes[0].linhas[0].titulo, '9h');
  assert.equal(descrever({ listResponseMessage: { title: '9h', singleSelectReply: { selectedRowId: 'm1' } } }).texto, '✅ 9h');
  const b = descrever({ buttonsMessage: { contentText: 'Confirma?', buttons: [{ buttonText: { displayText: 'Sim' } }, { buttonText: { displayText: 'Não' } }] } });
  assert.deepEqual(b.conteudo.botoes, ['Sim', 'Não']);
  assert.equal(descrever({ buttonsResponseMessage: { selectedDisplayText: 'Sim' } }).texto, '✅ Sim');
});

test('evento, convite de grupo, mensagem fixada e registro de ligação', () => {
  assert.match(descrever({ eventMessage: { name: 'Rock Hour', startTime: 1789000000, location: { name: 'Palco' } } }).texto, /^📅 Evento: Rock Hour — .* — Palco$/);
  assert.equal(descrever({ groupInviteMessage: { groupName: 'Banda', inviteCode: 'XyZ' } }).conteudo.link, 'https://chat.whatsapp.com/XyZ');
  assert.equal(descrever({ pinInChatMessage: { type: 1 } }).texto, '📌 Mensagem fixada');
  assert.equal(descrever({ callLogMesssage: { isVideo: false, callOutcome: 'MISSED' } }).texto, '📞 Chamada de voz perdida');
});

test('o que NÃO é bolha: protocolo, voto de enquete, álbum, edição cifrada; mídia continua sendo bolha', () => {
  assert.equal(descrever({ protocolMessage: { type: 0 } }).semConteudo, true);
  assert.equal(descrever({ senderKeyDistributionMessage: {}, messageContextInfo: {} }).semConteudo, true);
  assert.equal(descrever({ pollUpdateMessage: { vote: {} } }).semConteudo, true);
  assert.equal(descrever({ albumMessage: { expectedImageCount: 3 } }).semConteudo, true);
  assert.equal(descrever({ imageMessage: { mimetype: 'image/jpeg' } }).semConteudo, false);
  assert.equal(descrever({ viewOnceMessageV2: { message: { imageMessage: {} } } }).conteudo.contexto.visualizacaoUnica, true);
});

test('voto de enquete: decifra e acha as opções pelo SHA-256 do nome; troca de voto substitui', () => {
  const segredo = crypto.randomBytes(32);
  const opcoes = ['Sábado', 'Domingo', 'Feriado'];
  const hash = (o) => crypto.createHash('sha256').update(o).digest();
  const ld = (campo, buf) => Buffer.concat([Buffer.from([(campo << 3) | 2, buf.length]), buf]);
  const claro = Buffer.concat([ld(1, hash('Domingo')), ld(1, hash('Feriado'))]);
  const cif = enquete._cifrarVotoParaTeste({ segredo, enqueteId: 'POLL1', criador: '5519999990001@s.whatsapp.net', votante: '5519999990002@s.whatsapp.net', claro });
  const volta = enquete.decifrarVoto({ segredo, ...cif, enqueteId: 'POLL1', criador: '5519999990001@s.whatsapp.net', votante: '5519999990002@s.whatsapp.net' });
  assert.deepEqual(enquete.opcoesDoVoto(volta, opcoes), ['Domingo', 'Feriado']);
  assert.throws(() => enquete.decifrarVoto({ segredo, ...cif, enqueteId: 'POLL1', criador: '5519999990001@s.whatsapp.net', votante: '5519999990009@s.whatsapp.net' }), 'outro votante não abre');
  assert.equal(enquete.ehVoto({ pollUpdateMessage: { pollCreationMessageKey: { id: 'POLL1' }, vote: {} } }), true);
});

// ---- protocolo (paridade 3b): evento messages.edited e tipo numérico do histórico ----
const wh = require('../src/routes/webhook');
const { tipoProtocolo } = require('../src/waConteudo');

test('tipo do protocolo: nome (webhook) e número (histórico) dão no mesmo', () => {
  assert.equal(tipoProtocolo({ type: 'MESSAGE_EDIT' }), 'edicao');
  assert.equal(tipoProtocolo({ type: 14 }), 'edicao');
  assert.equal(tipoProtocolo({ type: 0 }), 'revogacao');
  assert.equal(tipoProtocolo({ type: 'REVOKE' }), 'revogacao');
  assert.equal(tipoProtocolo({ type: 3 }), 'temporarias');
  assert.equal(tipoProtocolo({}), null);
});

test('messages.edited: a protocolMessage vem como data — edição e apagamento são reconhecidos', () => {
  const edit = wh._detectEdit({ event: 'messages.edited', data: { key: { id: 'S1', remoteJid: '5519@s.whatsapp.net', fromMe: true }, type: 'MESSAGE_EDIT', editedMessage: { conversation: 'corrigido' } } });
  assert.deepEqual(edit, { id: 'S1', body: 'corrigido' });
  assert.deepEqual(wh._detectDelete({ event: 'messages.edited', data: { key: { id: 'S2', fromMe: true }, type: 'REVOKE' } }), ['S2']);
});

test('histórico (findMessages): protocolo com tipo NUMÉRICO também é edição/apagamento', () => {
  const rec = { key: { id: 'P1' }, message: { protocolMessage: { key: { id: 'ALVO' }, type: 14, editedMessage: { extendedTextMessage: { text: 'novo' } } } } };
  assert.deepEqual(wh._detectEdit({ data: rec }), { id: 'ALVO', body: 'novo' });
  const rev = { key: { id: 'P2' }, message: { protocolMessage: { key: { id: 'ALVO2' }, type: 0 } } };
  assert.deepEqual(wh._detectDelete({ data: rev }), ['ALVO2']);
  assert.equal(descrever(rec.message).semConteudo, true, 'edição não vira bolha');
});

test('mensagem upsert normal (messageType, sem type) não é confundida com protocolo', () => {
  const up = { event: 'messages.upsert', data: { key: { id: 'X' }, messageType: 'conversation', message: { conversation: 'oi' } } };
  assert.equal(wh._detectEdit(up), null);
  assert.deepEqual(wh._detectDelete(up), []);
  assert.deepEqual(wh._detectDelete({ event: 'messages.update', data: { keyId: 'X', status: 'READ' } }), []);
});

test('foto de álbum, temporárias, produto e pedido viram bolha', () => {
  const foto = descrever({ associatedChildMessage: { message: { imageMessage: { caption: 'turma', mimetype: 'image/jpeg' } } } });
  assert.equal(foto.semConteudo, false);
  assert.ok(foto.inner.imageMessage, 'mídia do álbum desembrulhada');
  const t = descrever({ protocolMessage: { type: 3, ephemeralExpiration: 604800 } });
  assert.equal(t.texto, '⏱ Mensagens temporárias ativadas (7 dias)');
  assert.equal(t.conteudo.tipo, 'sistema');
  assert.equal(descrever({ protocolMessage: { type: 'EPHEMERAL_SETTING', ephemeralExpiration: 0 } }).texto, '⏱ Mensagens temporárias desativadas');
  assert.match(descrever({ productMessage: { product: { title: 'Aula avulsa' } } }).texto, /Produto: Aula avulsa/);
  assert.match(descrever({ orderMessage: { itemCount: 2, orderTitle: 'Kit' } }).texto, /Pedido \(2 itens\): Kit/);
  assert.equal(descrever({ albumMessage: { expectedImageCount: 3 } }).semConteudo, true, 'cabeçalho do álbum não é bolha');
});
