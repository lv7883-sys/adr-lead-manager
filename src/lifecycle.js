'use strict';
// lifecycle.js — RÉGUA CANÔNICA de ciclo de vida do lead (Fatia A). Fonte única (molde do
// reativacao.js). Fecha as 6 definições divergentes de "lead ativo" e as 2 de "convertido".
//
// DEFINIÇÃO (uma só, multi-tenant, sem hardcode):
//   TERMINAL   = status ∈ {CONVERTED, WON}  OU  desfecho IS NOT NULL
//                (qualquer desfecho registrado = desfecho terminal → fora de ativo E de reativação)
//   CONVERTIDO = status ∈ {CONVERTED, WON}  OU  desfecho = 'matriculado'   (subconjunto de TERMINAL)
//   STATUS_VIVO= status ∈ {NEW, QUALIFYING, QUALIFIED, EXPERIMENTAL_AGENDADA}
//   LEAD ATIVO = STATUS_VIVO  E  NÃO TERMINAL  E  não-dormente
//                (dormência é ORTOGONAL — por dormancy_days do tenant; quem quer "ativo sem
//                 dormência", ex. métricas de espera, compõe STATUS_VIVO ∧ ¬TERMINAL).
//
// A raiz do bug era excluir por STATUS (só CONVERTED/WON) ignorando DESFECHO — matriculados e
// não-matriculados vazavam como "ativo"/"reativação". Aqui TERMINAL cobre os dois.

const STATUS_VIVO = ['NEW', 'QUALIFYING', 'QUALIFIED', 'EXPERIMENTAL_AGENDADA'];
const CONVERTIDO_STATUS = ['CONVERTED', 'WON'];

// ---- fragmentos SQL (metrics.js / endpoints). `a` = alias da tabela de leads. ----
function terminalSql(a = 'l') {
  return `(${a}.status IN ('CONVERTED','WON') OR ${a}.desfecho IS NOT NULL)`;
}
function convertidoSql(a = 'l') {
  return `(${a}.status IN ('CONVERTED','WON') OR ${a}.desfecho = 'matriculado')`;
}
function statusVivoSql(a = 'l') {
  return `${a}.status IN ('NEW','QUALIFYING','QUALIFIED','EXPERIMENTAL_AGENDADA')`;
}

// ---- predicados JS (agregação em JS do metrics.js / endpoint). `l` = linha do lead. ----
function isTerminal(l) {
  const s = String(l.status || '').toUpperCase();
  return CONVERTIDO_STATUS.includes(s) || l.desfecho != null;
}
function isConvertido(l) {
  const s = String(l.status || '').toUpperCase();
  return CONVERTIDO_STATUS.includes(s) || l.desfecho === 'matriculado';
}
function isStatusVivo(l) {
  return STATUS_VIVO.includes(String(l.status || '').toUpperCase());
}

module.exports = {
  STATUS_VIVO, CONVERTIDO_STATUS,
  terminalSql, convertidoSql, statusVivoSql,
  isTerminal, isConvertido, isStatusVivo,
};
