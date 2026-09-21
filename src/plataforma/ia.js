'use strict';
//
// ia.js — O ÚNICO LUGAR QUE FALA COM O SDK DE IA.
//
// Regra: nenhum outro arquivo de `src/` pode importar '@google/generative-ai'.
// O teste `test/sdk-ia-sem-atalho.test.js` falha se alguém importar, e existe por um
// motivo concreto: chamada de IA fora daqui é CUSTO ÓRFÃO — dinheiro gasto que não se
// atribui a nenhuma unidade. Num produto vendido por unidade, custo órfão é fatura que
// não fecha e preço que não se sustenta.
//
// O que este módulo faz, em toda chamada:
//   1. cria o modelo (o SDK mora só aqui);
//   2. executa;
//   3. grava um `consumo_evento` na conta da unidade dona do trabalho atual
//      (src/plataforma/contexto.js), best-effort;
//   4. se não houver unidade dona, registra `ia.custo_orfao` no log — alto, porque é
//      defeito de instrumentação, não evento de rotina.
//
// A medição NUNCA atrapalha a chamada: erro ao gravar consumo vira log, nunca exceção.
// A chamada de IA já custou; perder o registro é ruim, perder o resultado é pior.
//
const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../logger');
const consumo = require('./consumo');
const { unidadeAtual } = require('./contexto');

// Desliga a gravação depois da primeira falha estrutural (tabela ainda não existe, sem
// permissão). Sem isto, enquanto a migração 172 não for aplicada, CADA chamada de IA
// geraria uma linha de erro no log — barulho que esconde problema de verdade.
let _gravacaoDesligada = false;
let _orfaos = 0;

function _cliente() {
  const chave = process.env.GEMINI_API_KEY;
  if (!chave) throw new Error('GEMINI_API_KEY não configurada');
  return new GoogleGenerativeAI(chave);
}

/**
 * Modelo do SDK. Só este módulo constrói um — e recebe exatamente o mesmo objeto que
 * getGenerativeModel receberia, para a troca em src/gemini.js ser textual e sem risco.
 */
function modelo(opcoes) {
  return _cliente().getGenerativeModel(opcoes);
}

async function _gravar(tipo, quantidade, referencia) {
  if (_gravacaoDesligada) return;
  const dono = unidadeAtual();
  if (!dono) {
    _orfaos += 1;
    // Só as primeiras, e depois de 100 em 100: o alerta serve para consertar a
    // instrumentação, não para inundar o log.
    if (_orfaos <= 5 || _orfaos % 100 === 0) {
      logger.warn('ia.custo_orfao', {
        tipo,
        total_orfaos: _orfaos,
        dica: 'chamada de IA sem unidade dona — envolva o caminho em contexto.comUnidade()',
      });
    }
    return;
  }
  try {
    const ok = await consumo.registrarUso(dono.tenantId, dono.modulo, tipo, quantidade, { ref: referencia });
    if (!ok) _gravacaoDesligada = true;   // registrarUso já logou o porquê
  } catch (e) {
    _gravacaoDesligada = true;
    logger.error('ia.medicao_desligada', { error: e.message, motivo: 'primeira falha ao gravar consumo' });
  }
}

/**
 * Executa uma chamada de IA e cobra da unidade dona do trabalho atual.
 *
 * @param {{tipo?: string, quantidade?: number, ref?: string}} opcoes
 * @param {() => Promise<T>} fn  a chamada de verdade
 * @returns {Promise<T>}  exatamente o que `fn` devolver; erros passam intactos
 */
async function medir(opcoes, fn) {
  const tipo = (opcoes && opcoes.tipo) || consumo.TIPOS.IA_TEXTO;
  const quantidade = (opcoes && opcoes.quantidade) != null ? opcoes.quantidade : 1;
  try {
    return await fn();
  } finally {
    // `finally`: chamada que falhou no meio TAMBÉM custou (o provedor cobra a tentativa).
    // Não se espera a gravação para devolver a resposta.
    _gravar(tipo, quantidade, opcoes && opcoes.ref).catch(() => {});
  }
}

/** Diagnóstico (usado pelo teste e por quem quiser conferir a instrumentação). */
function _estado() {
  return { gravacaoDesligada: _gravacaoDesligada, orfaos: _orfaos };
}
function _reiniciar() { _gravacaoDesligada = false; _orfaos = 0; }

module.exports = { modelo, medir, TIPOS: consumo.TIPOS, _estado, _reiniciar };
