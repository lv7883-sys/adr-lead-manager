'use strict';
// reacao.js — FONTE ÚNICA do marcador de reação (emoji) numa mensagem.
//
// Reação NÃO é turno do cliente: um 👍 não significa "o cliente respondeu e está esperando".
// A régua já existia INLINE em tenant.js (last_in_turno, que alimenta "devemos resposta") e
// FALTAVA na contagem de não-lidas do inbox — então cada 👍 subia o badge, a recepção abria a
// conversa e não via nada novo. É o padrão clássico de "número inflado que não dá pra zerar
// entendendo o porquê" (auditoria de indicadores 2026-08-26).
//
// Marcador e predicado moram juntos aqui de propósito: quem GRAVA o prefixo (webhook, import de
// histórico) e quem FILTRA por ele (não-lidas, awaiting_reply) passam a ler a mesma constante.
// Antes eram 3 cópias da string em 3 arquivos — foi assim que a divergência nasceu.

const PREFIXO_REACAO = '[reação]';

// Texto da bolha de uma reação (ADR-031: reação não vira bolha vazia).
const textoReacao = (emoji) => `${PREFIXO_REACAO} ${emoji}`;

// Predicado SQL: esta mensagem é um TURNO de verdade (não é reação). `a` = alias de `messages`.
const naoEhReacaoSql = (a = 'm') => `coalesce(${a}.body, '') NOT LIKE '${PREFIXO_REACAO}%'`;

module.exports = { PREFIXO_REACAO, textoReacao, naoEhReacaoSql };
