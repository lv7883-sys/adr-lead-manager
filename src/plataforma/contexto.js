'use strict';
//
// contexto.js — QUEM É A UNIDADE DONA DO TRABALHO QUE ESTÁ RODANDO AGORA.
//
// O problema que isto resolve: medir o custo de IA por unidade exige saber de quem é a
// chamada. A alternativa seria passar `tenantId` por dentro de 12 arquivos e ~18 funções
// até chegar no ponto que fala com o Google — e bastaria UM caminho esquecido para nascer
// custo órfão, que é exatamente o que não pode existir num produto vendido por unidade.
//
// AsyncLocalStorage (biblioteca padrão do Node) carrega o dono junto da execução: quem
// abre o contexto no começo do processamento cobre TUDO que acontece dentro dele, em
// qualquer profundidade, sem que as funções do meio precisem saber que ele existe.
//
//   comUnidade(tenantId, { modulo: 'LEADS' }, async () => { ...processa... })
//   unidadeAtual()  ->  { tenantId, modulo }  ou  null
//
// É contexto de OBSERVAÇÃO, não de autorização: nada aqui decide o que alguém pode fazer.
// A RLS continua sendo o que isola dados, e `withTenant` continua sendo o que a alimenta.
//
const { AsyncLocalStorage } = require('node:async_hooks');

const _als = new AsyncLocalStorage();

/** Executa `fn` marcando a unidade dona. Devolve o que `fn` devolver. */
function comUnidade(tenantId, opcoes, fn) {
  // assinatura flexível: comUnidade(id, fn) ou comUnidade(id, { modulo }, fn)
  if (typeof opcoes === 'function') { fn = opcoes; opcoes = {}; }
  if (!tenantId) return fn();
  return _als.run({ tenantId: String(tenantId), modulo: (opcoes && opcoes.modulo) || 'LEADS' }, fn);
}

/** A unidade dona do trabalho atual, ou null se ninguém marcou. */
function unidadeAtual() {
  return _als.getStore() || null;
}

module.exports = { comUnidade, unidadeAtual };
