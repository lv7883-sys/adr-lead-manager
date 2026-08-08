'use strict';
// reativacao.js — FONTE ÚNICA da "retomada" (ADR-027, emenda #8 Fatia B).
//
// Uma RETOMADA = uma saída nossa (staff_outbound_samples) cuja lacuna desde o inbound
// ANTERIOR (o mais recente antes dela) é >= dormancy_days do tenant. Sem inbound anterior
// → NÃO conta (evita falso-positivo de 1º contato / resposta same-day).
//
// FORMA EM JANELA (2026-08-07 — lição do incidente de perf do /leads): CTEs que agregam UMA
// vez por ident (dígitos do telefone) — O(n log n) no total. A forma antiga (LEFT JOIN
// LATERAL por lead) re-varria staff/messages POR LINHA e, sob RLS, o planner rebaixa filtros
// de expressão (regexp_replace não é leakproof) p/ depois da security qual → seq scan por
// lead (~30s na tela de Leads; o Regente corta em 10s). Usada por tenant.js (/leads),
// metrics.js (BI) e plantao.js — os TRÊS dão o MESMO número pros mesmos dados.
//
// USO (o chamador injeta na sua WITH):
//   `WITH ${retomadaCtes('$2')}            -- ou { schema: 'lead_manager.' } p/ quem qualifica
//    SELECT ... FROM leads l
//    ${identLateral('l')}                   -- li.ident = dígitos de phone/meta_psid
//    LEFT JOIN rt_retom rtm ON li.ident <> '' AND rtm.ident = li.ident
//    LEFT JOIN rt_in   rin ON li.ident <> '' AND rin.ident = li.ident`
//   retomada:          rtm.retomada_em (NULL = nunca)
//   reengajou:         rin.last_in > rtm.retomada_em
//   reengajou desde X: rin.last_in > rtm.retomada_em AND rin.last_in >= X
//   (max > threshold ≡ EXISTS > threshold — as condições são fechadas p/ cima, então o
//    máximo satisfaz sse algum elemento satisfaz. rt_in não referenciada não executa.)

// CTEs rt_ev/rt_retom/rt_in. `dorm` = expressão SQL de dormancy_days (ex.: '$2' ou literal).
function retomadaCtes(dorm, { schema = '' } = {}) {
  return `rt_ev AS (
    SELECT regexp_replace(cv.external_id, '[^0-9]', '', 'g') AS ident, m.received_at, 'in'::text AS kind
      FROM ${schema}messages m JOIN ${schema}conversations cv ON cv.id = m.conversation_id
     WHERE m.role = 'USER'
    UNION ALL
    SELECT regexp_replace(s.external_id, '[^0-9]', '', 'g'), s.received_at, 'out'
      FROM ${schema}staff_outbound_samples s
  ),
  rt_retom AS (
    SELECT ident, max(received_at) AS retomada_em
      FROM (SELECT ident, received_at, kind,
                   max(CASE WHEN kind = 'in' THEN received_at END)
                     OVER (PARTITION BY ident ORDER BY received_at
                           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_in
              FROM rt_ev) e
     WHERE kind = 'out' AND prev_in <= received_at - make_interval(days => (${dorm})::int)
     GROUP BY ident
  ),
  rt_in AS (
    SELECT ident, max(received_at) AS last_in FROM rt_ev WHERE kind = 'in' GROUP BY ident
  )`;
}

// LATERAL do ident do lead (dígitos de phone/meta_psid) — a ponte leads↔CTEs acima.
function identLateral(alias = 'l') {
  return `LEFT JOIN LATERAL (
    SELECT regexp_replace(coalesce(${alias}.phone, ${alias}.meta_psid, ''), '[^0-9]', '', 'g') AS ident
  ) li ON true`;
}

module.exports = { retomadaCtes, identLateral };
