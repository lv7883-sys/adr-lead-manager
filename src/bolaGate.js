'use strict';

// ADR-030 Passo 2 — GATE DETERMINÍSTICO da SAÍDA da recepção ("passou a bola" vs "enrolou").
// Molde do _ehCloser (metrics.js): normaliza o texto (tira assinatura *Nome*, acento, emoji,
// pontuação, caixa) e casa FRASES de enrolação. Conservador: o "?" sozinho NÃO decide — a
// ambiguidade cai na Camada 2 (modelo leve). PURO/sem I/O (fácil de unit-testar).

// Frases de "enrolação" = promessa sem entrega; a bola CONTINUA conosco. Lista curada dos
// exemplos reais da Valinhos (recon Passo 2). O texto é DESACENTUADO antes de casar, então
// as formas sem acento ('ja te') cobrem também as acentuadas ('já te').
const ENROLACAO_PATTERNS = [
  'vou ver', 'vou verificar', 'vou checar', 'vou confirmar', 'vou olhar',
  'te aviso', 'te retorno', 'te dou um retorno', 'dou um retorno',
  'a gente avisa', 'a gente te avisa', 'assim que', 'logo mais',
  'um minutinho', 'um momento', 'deixa eu ver', 'deixa eu verificar',
  'ja te', 'ja retorno', 'ja aviso',
];

// Normaliza p/ casar frase: tira assinatura, desacentua, minúsculas, remove emoji/pontuação,
// colapsa espaço. (Não confundir com o "?" da decisão, que é lido do texto ORIGINAL.)
function normalizarSaida(text) {
  return String(text || '')
    .replace(/^\*[^*]+\*\s*/, ' ')                        // assinatura *Nome* do atendente
    .normalize('NFD').replace(/[̀-ͯ]/g, '')    // desacentua ("já" -> "ja")
    .toLowerCase()
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}️]/gu, ' ') // emojis
    .replace(/[!.,;:()\-—…"'’\n\r]/g, ' ')                // pontuação -> espaço
    .replace(/\s+/g, ' ')
    .trim();
}

// Decisão do gate: 'passou_bola' | 'enrolou' | 'ambiguo'. Regra (ADR-030):
//  - bate ENROLACAO e é curta (sem info entregue) e SEM "?" -> ENROLOU (bola nossa)
//  - pergunta LIMPA (termina em "?", NÃO bate ENROLACAO) -> PASSOU_BOLA
//  - "?" + enrolação, "vou confirmar" sem "?", frase longa com enrolação, afirmação sem "?"
//    -> AMBIGUO (Camada 2). O "?" sozinho não decide.
function gateSaida(text) {
  const norm = normalizarSaida(text);
  if (!norm) return 'ambiguo';
  const temEnrolacao = ENROLACAO_PATTERNS.some((p) => norm.includes(p));
  const pergunta = /\?\s*$/.test(String(text || '').trim());  // "pergunta limpa" = termina em "?"
  const curta = norm.length < 60;                             // proxy de "sem info entregue"
  if (temEnrolacao && pergunta) return 'ambiguo';
  if (temEnrolacao && curta) return 'enrolou';
  if (temEnrolacao) return 'ambiguo';                         // longa: pode ter entregado info
  if (pergunta) return 'passou_bola';
  return 'ambiguo';                                           // afirmação sem "?" -> IA decide
}

module.exports = { ENROLACAO_PATTERNS, normalizarSaida, gateSaida };
