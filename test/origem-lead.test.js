'use strict';
// lead-source.test.js — PARSER de origem (sem DB). O dado do anúncio chega uma única vez:
// o que este teste cobre é exatamente o que separa "sei de onde veio" de "perdi para sempre".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const origemLead = require('../src/origemLead');

const { analisar, extrairAnuncio, extrairCodigoCampanha } = origemLead;

// Um externalAdReply como a Meta o manda no 1º contato de um Click-to-WhatsApp.
const AD = {
  sourceId: '120210000000000000',
  sourceUrl: 'https://fb.me/2abcDEF',
  sourceType: 'ad',
  title: 'Aulas de bateria em Valinhos',
  body: 'Primeira aula experimental gratuita',
  mediaType: 'IMAGE',
  thumbnailUrl: 'https://scontent.xx.fbcdn.net/x.jpg',
  ctwaClid: 'ARAqwerty',   // existe no payload; NÃO é usado pela atribuição
};

// ── (1) externalAdReply ────────────────────────────────────────────────────────────────
test('(1) externalAdReply em extendedTextMessage -> external_ad_reply', () => {
  const message = { extendedTextMessage: { text: 'Oi, vi o anúncio', contextInfo: { externalAdReply: AD } } };
  const r = analisar({ message, texto: 'Oi, vi o anúncio' });
  assert.equal(r.metodo, 'anuncio_meta');
  assert.equal(r.codigoCampanha, null);
  assert.deepEqual(r.anuncio, {
    anuncioId: '120210000000000000',
    anuncioUrl: 'https://fb.me/2abcDEF',
    anuncioTitulo: 'Aulas de bateria em Valinhos',
    anuncioTexto: 'Primeira aula experimental gratuita',
  });
});

test('(1b) o anúncio é achado em qualquer submessage — e dentro de embrulho', () => {
  const naImagem = extrairAnuncio({ imageMessage: { caption: 'oi', contextInfo: { externalAdReply: AD } } });
  assert.equal(naImagem.anuncioId, AD.sourceId);
  // mensagem temporária embrulha a mensagem real: o anúncio não pode ficar no embrulho
  const temporaria = extrairAnuncio({
    ephemeralMessage: { message: { extendedTextMessage: { text: 'oi', contextInfo: { externalAdReply: AD } } } },
  });
  assert.equal(temporaria.anuncioId, AD.sourceId);
  // contextInfo na raiz (formato que algumas versões mandam)
  assert.equal(extrairAnuncio({ contextInfo: { externalAdReply: AD } }).anuncioId, AD.sourceId);
});

test('(1c) só o que a atribuição usa é lido — ctwaClid/thumbnail ficam de fora', () => {
  const r = extrairAnuncio({ extendedTextMessage: { contextInfo: { externalAdReply: AD } } });
  assert.deepEqual(Object.keys(r).sort(), ['anuncioId', 'anuncioTexto', 'anuncioTitulo', 'anuncioUrl']);
});

// ── (2) código no texto ────────────────────────────────────────────────────────────────
test('(2) código [XX] no fim do texto -> codigo_campanha', () => {
  const r = analisar({ message: { conversation: 'Quero saber mais [RK3]' }, texto: 'Quero saber mais [RK3]' });
  assert.equal(r.metodo, 'codigo_campanha');
  assert.equal(r.codigoCampanha, 'RK3');
  assert.equal(r.anuncio, null);
});

test('(2b) a régua do código: 2 a 4 maiúsculas/dígitos, no FIM', () => {
  assert.equal(extrairCodigoCampanha('Oi [RK]'), 'RK');
  assert.equal(extrairCodigoCampanha('Oi [RK12]'), 'RK12');
  assert.equal(extrairCodigoCampanha('Oi [RK3]   \n'), 'RK3');       // espaço/quebra no fim não atrapalha
  assert.equal(extrairCodigoCampanha('Oi [rk3]'), null);             // minúscula não é nosso código
  assert.equal(extrairCodigoCampanha('Oi [R]'), null);               // curto demais
  assert.equal(extrairCodigoCampanha('Oi [RK123]'), null);           // longo demais
  assert.equal(extrairCodigoCampanha('Oi [RK3] e mais'), null);      // no meio = texto da pessoa
  assert.equal(extrairCodigoCampanha('[RK3]'), 'RK3');               // texto só com o código
  assert.equal(extrairCodigoCampanha(''), null);
  assert.equal(extrairCodigoCampanha(null), null);
  // legenda de imagem entra com prefixo do placeholder e o código continua no fim
  assert.equal(extrairCodigoCampanha('[imagem] Quero saber mais [RK3]'), 'RK3');
});

// ── (3) os dois juntos ─────────────────────────────────────────────────────────────────
test('(3) anúncio E código -> grava os dois, o código manda', () => {
  const message = { extendedTextMessage: { text: 'Quero saber mais [RK3]', contextInfo: { externalAdReply: AD } } };
  const r = analisar({ message, texto: 'Quero saber mais [RK3]' });
  assert.equal(r.metodo, 'codigo_campanha');    // o código é nosso: não muda sem aviso
  assert.equal(r.codigoCampanha, 'RK3');
  assert.equal(r.anuncio.anuncioId, AD.sourceId); // e o anúncio não se perde
});

// ── (4) nenhum dos dois ────────────────────────────────────────────────────────────────
test('(4) mensagem comum -> none (e o payload bruto ainda assim é gravado)', () => {
  const r = analisar({ message: { conversation: 'Bom dia, vocês têm aula de violão?' }, texto: 'Bom dia, vocês têm aula de violão?' });
  assert.deepEqual(r, { anuncio: null, codigoCampanha: null, metodo: 'nenhum' });
});

// ── (5) payload malformado: nunca lança, sempre devolve um veredito ────────────────────
test('(5) payload malformado não derruba o parser', () => {
  const lixos = [
    undefined, null, {}, { message: null }, { message: 'texto' }, { message: 42 }, { message: [] },
    { message: { extendedTextMessage: null } },
    { message: { extendedTextMessage: { contextInfo: 'não é objeto' } } },
    { message: { extendedTextMessage: { contextInfo: { externalAdReply: null } } } },
    { message: { extendedTextMessage: { contextInfo: { externalAdReply: 'string' } } } },
    { message: { extendedTextMessage: { contextInfo: { externalAdReply: [] } } } },
    { message: { extendedTextMessage: { contextInfo: { externalAdReply: {} } } } },          // vazio = ruído
    { message: { extendedTextMessage: { contextInfo: { externalAdReply: { sourceId: '' } } } } },
    { message: { ephemeralMessage: { message: null } } },
    { message: { conversation: 'oi' }, texto: 12345 },
    { message: { conversation: 'oi' }, texto: { nao: 'é string' } },
  ];
  for (const l of lixos) {
    const r = analisar(l || undefined);
    assert.ok(['anuncio_meta', 'codigo_campanha', 'nenhum'].includes(r.metodo),
      `veredito inválido para ${JSON.stringify(l)}`);
  }
  // o objeto vazio é ruído, não atribuição
  assert.equal(analisar({ message: { extendedTextMessage: { contextInfo: { externalAdReply: {} } } } }).metodo, 'nenhum');
  // ...mas um anúncio só com título (sem sourceId) ainda é sinal
  assert.equal(analisar({ message: { extendedTextMessage: { contextInfo: { externalAdReply: { title: 'Aulas' } } } } }).metodo,
    'anuncio_meta');
  assert.equal(analisar().metodo, 'nenhum');
});

test('(6) campo gigante do payload é truncado antes de virar linha', () => {
  const r = extrairAnuncio({ extendedTextMessage: { contextInfo: { externalAdReply: { title: 'x'.repeat(9000) } } } });
  assert.equal(r.anuncioTitulo.length, 2000);
});
