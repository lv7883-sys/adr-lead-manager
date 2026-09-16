'use strict';
//
// travaAssunto.js — ASSUNTOS QUE A EMPRESA PROIBIU (perfil da assistente → "O que ela NÃO DEVE falar").
//
// Na sugestão que a recepção revisa, a proibição vai só no prompt (um humano lê antes de enviar). Onde a
// resposta sai SOZINHA (fora do horário; auto-envio da renovação) o prompt não basta — a lição do
// temaProibido.js é que a IA escorrega mesmo proibida. Então vira TRAVA, na entrada e na saída:
//   1) o assunto aparece escrito no texto (sem acento/maiúscula)         → barra, sem gastar IA;
//   2) senão, o classificador (gemini.tocaAssuntoProibido) decide o sutil → barra se tocar;
//   3) classificador fora do ar                                           → barra (erra para o lado seguro).
// Barrou → quem chama manda o mesmo aviso fixo dos assuntos da recepção.
//
const perfilIA = require('./perfilAssistente');
const gemini = require('./gemini');
const logger = require('./logger');

async function verificar(texto, assuntos, { checar } = {}) {
  const lista = perfilIA.normalizarAssuntos(assuntos);
  const t = String(texto || '').trim();
  if (!lista.length || !t) return null;
  const escrito = perfilIA.assuntoEscrito(t, lista);
  if (escrito) return { tema: 'nao_falar', trecho: escrito };
  try {
    const r = await (checar || gemini.tocaAssuntoProibido)({ texto: t, assuntos: lista });
    return r && r.toca ? { tema: 'nao_falar', trecho: r.assunto || lista[0] } : null;
  } catch (e) {
    logger.warn('trava_assunto.checagem_falhou', { error: e.message });
    return { tema: 'nao_falar', trecho: '(verificação indisponível)' };
  }
}

module.exports = { verificar };
