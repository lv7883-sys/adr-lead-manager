'use strict';
// reativacao.js — FONTE ÚNICA da "retomada" (ADR-027, emenda #8 Fatia B).
//
// Uma RETOMADA = uma saída nossa (staff_outbound_samples) cuja lacuna desde o inbound
// ANTERIOR (o mais recente antes dela) é >= dormancy_days do tenant. Sem inbound anterior
// → a comparação é NULL → NÃO conta (evita falso-positivo de 1º contato / resposta same-day).
//
// Esta era a regra que a Fase 1 introduziu SÓ no /leads (tenant.js). A Fatia B extrai-a
// pra cá e a reusa em tenant.js (/leads), metrics.js (BI de gestão) e plantao.js — assim os
// TRÊS lugares dão o MESMO número de retomadas pros mesmos dados (antes divergiam: metrics
// e plantão liam reabordagem_tentativas, a fonte antiga).
//
// Tabelas: por padrão UNQUALIFIED (o search_path do lead_manager_user já aponta pro schema).
// `schema='lead_manager.'` p/ quem qualifica (plantao.js). `dorm` = expressão SQL de
// dormancy_days (param, ex.: '$3', ou literal). `alias` = alias da tabela de leads na FROM.

// LEFT JOIN LATERAL que devolve `rtm.retomada_em` (última saída-retomada do lead, ou NULL).
function retomadaLateral(dorm, { alias = 'l', schema = '' } = {}) {
  return `LEFT JOIN LATERAL (
    SELECT max(s.received_at) AS retomada_em
      FROM ${schema}staff_outbound_samples s
     WHERE regexp_replace(s.external_id, '[^0-9]', '', 'g')
         = regexp_replace(coalesce(${alias}.phone, ${alias}.meta_psid, ''), '[^0-9]', '', 'g')
       AND (SELECT max(m.received_at) FROM ${schema}messages m
              JOIN ${schema}conversations cv ON cv.id = m.conversation_id
             WHERE cv.external_id = ${alias}.phone AND m.role = 'USER'
               AND m.received_at < s.received_at)
           <= s.received_at - make_interval(days => (${dorm})::int)
  ) rtm ON true`;
}

// EXISTS de REENGAJAMENTO: inbound do lead APÓS a retomada (`retomadaCol` = expressão da
// retomada_em, ex.: 'rtm.retomada_em'). `since` (opcional) = expressão SQL p/ limitar o
// inbound a uma janela (ex.: SP_HOJE no plantão).
function reengajouExists(retomadaCol, { alias = 'l', schema = '', since = null } = {}) {
  const sinceClause = since ? ` AND m.received_at >= ${since}` : '';
  return `EXISTS (SELECT 1 FROM ${schema}messages m JOIN ${schema}conversations cv ON cv.id = m.conversation_id
                   WHERE cv.external_id = ${alias}.phone AND m.role = 'USER'
                     AND m.received_at > ${retomadaCol}${sinceClause})`;
}

module.exports = { retomadaLateral, reengajouExists };
