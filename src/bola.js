'use strict';
//
// bola.js — FONTE ÚNICA de "DE QUEM É A BOLA".
//
// Por que este arquivo existe (22/09/2026). "De quem é a bola" é a pergunta mais repetida do
// Regente — ela decide a Fila de Ação, o SLA, o badge de pendências, o que a recepção vê como
// "devemos resposta" e se um rascunho da IA ainda vale. E era a única pergunta central da casa
// SEM régua única: existiam QUATRO implementações independentes, e uma delas fazia a pergunta ao
// contrário das outras três.
//
//   1. routes/tenant.js  `awaiting_reply`   — SQL, compara o estado com a SAÍDA nossa
//   2. metrics.js        `esperandoNos`     — JS,  idem, mas sem checar o turno do cliente
//   3. metrics.js        `stateFresh`       — JS,  a forma COMPLETA (turno do cliente E saída)
//   4. jobs/sweep-stale-drafts `estado_stale` — SQL, compara o estado com a ENTRADA do cliente
//
// Os comentários de cada uma diziam "mesma régua de antes" e "mesma regra dos outros dois pontos
// de leitura" — não eram. Isso não foi decisão de arquitetura: foi remendo convergente, cada leitor
// corrigido quando o defeito apareceu NAQUELA tela. O resultado é o que a recepção sente: o mesmo
// lead aparece esperando resposta numa tela e não aparece em outra.
//
// O QUE ESTA RÉGUA DECIDE. `conversation_state` é um veredito da IA com data (`state_computed_at`).
// Ele vale enquanto NADA aconteceu depois dele. Duas coisas o vencem:
//   • o cliente falou depois     → o veredito é anterior ao fato; não sabe do turno novo;
//   • nós respondemos depois     → só derruba "AGUARDANDO_RECEPCAO" (a dívida foi paga).
//     Responder não derruba AGUARDANDO_CLIENTE nem RESOLVIDO: insistir com quem já tem a bola não
//     devolve a bola para nós.
// Vencido o veredito, a resposta sai dos FATOS: quem falou por último. É o mesmo fallback que a
// Fila de Ação já usava — aqui ele passa a valer para todo mundo.
//
// REAÇÃO NÃO É TURNO: quem chama esta régua entrega `lastInTurno`, não `last_in`. Um 👍 não é o
// cliente falando (src/reacao.js). Em SQL, use `naoEhReacaoSql` para montar esse agregado.
//
// ⚠ ESTA RÉGUA NÃO ESCREVE NADA. Ela deriva na LEITURA. O campo `conversation_state` continua
// sendo gravado pelo motor (engine.classificarSaida) e continua ficando velho — a diferença é que
// agora existe UM lugar que sabe descontar isso, em vez de quatro que tentam.
//
// ORDEM DE EXECUÇÃO (lição da auditoria de 22/09, e o motivo de este arquivo vir ANTES de mexer no
// motor): não se apaga a compensação dos leitores primeiro. Medido em produção naquele dia, o campo
// estava errado em 27 dos 28 leads ativos que ele marcava como AGUARDANDO_RECEPCAO. Quem compensava
// acertava; quem lia o campo cru mostrava o errado. Tirar a compensação antes de existir a régua
// deixaria as telas PIORES do que estavam.

// Vereditos possíveis. 'nossa' = devemos resposta. 'cliente' = a bola está com ele (monitorar/
// retomada). 'resolvido' = a conversa fechou. 'indefinida' = não há evidência para afirmar —
// NUNCA é tratado como "nossa" nem some da tela; aparece em bucket calmo.
const NOSSA = 'nossa';
const CLIENTE = 'cliente';
const RESOLVIDO = 'resolvido';
const INDEFINIDA = 'indefinida';

// conversation_state → veredito, quando o estado ainda vale.
const DO_ESTADO = {
  AGUARDANDO_RECEPCAO: NOSSA,
  AGUARDANDO_CLIENTE: CLIENTE,
  RESOLVIDO,
  INDEFINIDO: INDEFINIDA,
};

const _ms = (v) => {
  if (v == null) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
};

/**
 * De quem é a bola, em JS.
 *
 * @param {object} l                  o lead, com os agregados já calculados
 * @param {string} l.conversation_state  veredito da IA (pode ser null)
 * @param {Date|string} l.state_computed_at  quando o veredito foi gravado
 * @param {Date|string} l.last_in_turno  último TURNO do cliente (sem reação — ver src/reacao.js)
 * @param {Date|string} l.last_out       última saída nossa (staff_outbound_samples)
 * @param {Date|string} l.created_at     âncora de quem nunca trocou mensagem
 * @returns {{bola: string, desde: number|null, via: 'estado'|'fatos'}}
 *          `desde` = desde quando a bola está com quem está (para o relógio das telas).
 *          `via` diz se quem decidiu foi o veredito da IA ou os fatos — é o que torna a
 *          divergência auditável em vez de invisível.
 */
function deQuemEhABola(l) {
  const estado = (l && l.conversation_state) || null;
  const stateAt = _ms(l && l.state_computed_at);
  const lin = _ms(l && l.last_in_turno);
  const lout = _ms(l && l.last_out);
  const nasceu = _ms(l && l.created_at);

  // O veredito vale? (a) o cliente não falou depois dele; (b) se ele diz que devemos resposta,
  // nós não respondemos depois. Empate conta como "nada aconteceu depois" (viés conservador:
  // na dúvida a bola continua onde o veredito disse).
  const clienteFalouDepois = lin != null && (stateAt == null || stateAt < lin);
  const pagamosDepois = estado === 'AGUARDANDO_RECEPCAO' && lout != null && stateAt != null && lout > stateAt;
  const valeOEstado = !!estado && !clienteFalouDepois && !pagamosDepois;

  if (valeOEstado && DO_ESTADO[estado]) {
    const bola = DO_ESTADO[estado];
    // O relógio conta desde o EVENTO que pôs a bola ali, não desde o carimbo do veredito: o
    // carimbo é quando a IA percebeu, e a recepção quer saber desde quando a pessoa espera.
    // A ordem de fallback é a MESMA que a Fila de Ação já usava (mensagem → saída → cadastro),
    // para que ligar esta régua não mude nenhum relógio de tela.
    const desde = bola === NOSSA ? (lin != null ? lin : lout)
      : bola === CLIENTE ? (lout != null ? lout : lin)
        : (lin != null ? lin : lout);
    return { bola, desde: desde != null ? desde : nasceu, via: 'estado' };
  }

  // Sem veredito válido: valem os fatos — quem falou por último.
  if (lin != null && (lout == null || lin > lout)) return { bola: NOSSA, desde: lin, via: 'fatos' };
  if (lout != null) return { bola: CLIENTE, desde: lout, via: 'fatos' };
  return { bola: INDEFINIDA, desde: nasceu, via: 'fatos' };
}

// Atalho para o caso mais perguntado do sistema.
const devemosResposta = (l) => deQuemEhABola(l).bola === NOSSA;

/**
 * A MESMA régua em SQL, para quem decide dentro da consulta (listas grandes, agregados).
 * Devolve uma expressão `text` com o mesmo vocabulário do JS ('nossa'|'cliente'|'resolvido'|
 * 'indefinida'). O teste de paridade garante que as duas formas respondem igual — se alguém mudar
 * uma e esquecer a outra, o teste quebra.
 *
 * @param {object} col  de onde vêm os quatro ingredientes na consulta do chamador
 */
function bolaSql({
  estado = 'l.conversation_state',
  stateAt = 'l.state_computed_at',
  lastInTurno,
  lastOut,
} = {}) {
  if (!lastInTurno || !lastOut) throw new Error('bolaSql: lastInTurno e lastOut são obrigatórios (agregados do chamador)');
  const valeOEstado = `(${estado} IS NOT NULL
      AND NOT (${lastInTurno} IS NOT NULL AND (${stateAt} IS NULL OR ${stateAt} < ${lastInTurno}))
      AND NOT (${estado} = 'AGUARDANDO_RECEPCAO' AND ${lastOut} IS NOT NULL
               AND ${stateAt} IS NOT NULL AND ${lastOut} > ${stateAt}))`;
  return `(CASE
    WHEN ${valeOEstado} AND ${estado} = 'AGUARDANDO_RECEPCAO' THEN '${NOSSA}'
    WHEN ${valeOEstado} AND ${estado} = 'AGUARDANDO_CLIENTE'  THEN '${CLIENTE}'
    WHEN ${valeOEstado} AND ${estado} = 'RESOLVIDO'           THEN '${RESOLVIDO}'
    WHEN ${valeOEstado} AND ${estado} = 'INDEFINIDO'          THEN '${INDEFINIDA}'
    WHEN ${lastInTurno} IS NOT NULL
     AND (${lastOut} IS NULL OR ${lastInTurno} > ${lastOut})  THEN '${NOSSA}'
    WHEN ${lastOut} IS NOT NULL                               THEN '${CLIENTE}'
    ELSE '${INDEFINIDA}'
  END)`;
}

// Açúcar para o predicado mais usado em SQL ("devemos resposta").
const devemosRespostaSql = (col) => `(${bolaSql(col)} = '${NOSSA}')`;

/**
 * "O VEREDITO DA IA AINDA VALE?" — só a parte de frescor, sem traduzir para de-quem-é-a-bola.
 *
 * Existe porque nem todo chamador faz a pergunta completa. A faxina de rascunhos (sweep-stale-
 * drafts) pergunta outra coisa: "o estado gravado ainda descreve a conversa?" — e era justamente
 * ela a quarta cópia divergente, comparando o carimbo com a ENTRADA do cliente enquanto as outras
 * três comparavam com a SAÍDA nossa. As duas comparações estão certas; são perguntas diferentes.
 * Expondo o frescor aqui, a faxina passa a compartilhar a régua sem mudar o que ela decide.
 */
function estadoValeSql({ estado = 'l.conversation_state', stateAt = 'l.state_computed_at', lastInTurno, lastOut } = {}) {
  if (!lastInTurno) throw new Error('estadoValeSql: lastInTurno é obrigatório');
  const pago = lastOut
    ? ` AND NOT (${estado} = 'AGUARDANDO_RECEPCAO' AND ${lastOut} IS NOT NULL
               AND ${stateAt} IS NOT NULL AND ${lastOut} > ${stateAt})`
    : '';
  return `(${estado} IS NOT NULL
      AND NOT (${lastInTurno} IS NOT NULL AND (${stateAt} IS NULL OR ${stateAt} < ${lastInTurno}))${pago})`;
}

module.exports = {
  NOSSA, CLIENTE, RESOLVIDO, INDEFINIDA, DO_ESTADO,
  deQuemEhABola, devemosResposta, bolaSql, devemosRespostaSql, estadoValeSql,
};
