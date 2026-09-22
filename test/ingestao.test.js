'use strict';
// ingestao.test.js — as decisões PURAS da ingestão, offline (sem banco, sem rede).
//
// São as que decidem, sozinhas, se um arquivo entra ou não. Um erro aqui não dá erro em
// lugar nenhum: só faz entrar lixo (figurinha virando "foto de aula") ou deixar de entrar
// o que importa — e nada disso aparece num log.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const ingestao = require('../src/marketing/ingestao');

// ═══ que conteúdo entra ═════════════════════════════════════════════════════════════════

test('foto e vídeo entram; texto, áudio e documento não', () => {
  assert.equal(ingestao._tipoAceito({ kind: 'image', mimetype: 'image/jpeg' }), 'imagem');
  assert.equal(ingestao._tipoAceito({ kind: 'video', mimetype: 'video/mp4' }), 'video');
  assert.equal(ingestao._tipoAceito({ kind: 'audio', mimetype: 'audio/ogg' }), null);
  assert.equal(ingestao._tipoAceito({ kind: 'document', mimetype: 'application/pdf' }), null);
  assert.equal(ingestao._tipoAceito(null), null);          // texto puro: o webhook manda media = null
  assert.equal(ingestao._tipoAceito({}), null);
});

test('FIGURINHA não entra, mesmo chegando como kind "image"', () => {
  // Esta é a armadilha real: o normalizador do webhook entrega figurinha como kind 'image'
  // (para renderizar no mesmo <img> da Caixa de Entrada). Se a ingestão confiasse só no
  // kind, todo 👍 em figurinha viraria matéria-prima de post.
  assert.equal(ingestao._tipoAceito({
    kind: 'image', mimetype: 'image/webp', rawMessage: { stickerMessage: { mimetype: 'image/webp' } },
  }), null, 'figurinha reconhecida pelo stickerMessage');

  assert.equal(ingestao._tipoAceito({ kind: 'image', mimetype: 'image/webp' }), null,
    'e também pelo mime, se o cru não vier');

  // A trava não pode ser larga demais: foto de verdade continua entrando.
  assert.equal(ingestao._tipoAceito({
    kind: 'image', mimetype: 'image/jpeg', rawMessage: { imageMessage: { mimetype: 'image/jpeg' } },
  }), 'imagem');
});

// ═══ cota ═══════════════════════════════════════════════════════════════════════════════

test('cota: ausente é sem limite; cheia recusa; abaixo do limite passa', () => {
  assert.equal(ingestao._excedeCota({}, 9999), null, 'sem cota configurada = sem limite');
  assert.equal(ingestao._excedeCota(null, 5), null);
  assert.equal(ingestao._excedeCota({ midias_mes: 'muitas' }, 5), null, 'cota ilegível não bloqueia');
  assert.equal(ingestao._excedeCota({ midias_mes: 10 }, 9), null, 'ainda cabe uma');

  const cheio = ingestao._excedeCota({ midias_mes: 10 }, 10);
  assert.deepEqual(cheio, { cota: 'midias_mes', limite: 10, usado: 10 },
    'o motivo vai escrito na linha: sem isso, "sumiu" é a única explicação disponível');

  // Cota zero é "desligado", não "sem limite".
  assert.ok(ingestao._excedeCota({ midias_mes: 0 }, 0));
});

// ═══ metadados ══════════════════════════════════════════════════════════════════════════

test('duração do vídeo sai do cru quando o WhatsApp informa', () => {
  assert.equal(ingestao._duracao({ rawMessage: { videoMessage: { seconds: 42 } } }), 42);
  assert.equal(ingestao._duracao({ rawMessage: { ptvMessage: { seconds: 7 } } }), 7, 'vídeo redondo');
  assert.equal(ingestao._duracao({ rawMessage: { imageMessage: {} } }), null, 'foto não tem duração');
  assert.equal(ingestao._duracao({}), null);
  assert.equal(ingestao._duracao(null), null);
  assert.equal(ingestao._duracao({ rawMessage: { videoMessage: { seconds: 'x' } } }), null);
});

// ═══ prazo ══════════════════════════════════════════════════════════════════════════════

test('o download tem prazo: pendurado não segura o webhook para sempre', async () => {
  const pendurada = new Promise(() => {});   // nunca resolve, como um socket travado
  await assert.rejects(
    ingestao._comPrazo(pendurada, 30, 'download da mídia'),
    /download da mídia: estourou 30ms/);

  // E quem responde a tempo passa limpo.
  assert.equal(await ingestao._comPrazo(Promise.resolve('ok'), 1000, 'x'), 'ok');
});
