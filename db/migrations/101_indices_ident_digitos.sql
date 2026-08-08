-- ============================================================
-- 101 — FORMALIZA os índices criados AD-HOC na produção em 2026-08-07, durante o incidente
-- de perf do /leads (aba Leads do Regente estourando o timeout de 10s; ver memória do
-- incidente e o commit b922330 — reescrita da query em CTEs).
--
-- POR QUE EXISTEM: o cruzamento canônico conversa↔lead↔saída é por DÍGITOS do telefone
-- (regexp_replace(external_id, '[^0-9]', '', 'g') — o "ident" do ARC-042). Sem índice de
-- expressão, cada casamento vira seq scan de messages/staff_outbound_samples. Os índices
-- ajudam as agregações das CTEs (tenant.js /leads, metrics.js, plantao.js) e quaisquer
-- lookups pontuais por telefone/ident.
--
-- NOTA (lição do incidente): sob RLS o planner NÃO consegue usar índice de expressão como
-- Index Cond quando a security qual vem antes (regexp_replace não é leakproof) — nesses
-- planos o filtro roda como Filter pós-índice. Os índices seguem valendo p/ os caminhos
-- sem essa limitação (agregação única, lookups por igualdade simples como idx_conv_extid).
--
-- EM PRODUÇÃO JÁ EXISTEM (criados com CREATE INDEX CONCURRENTLY na mão) → aqui IF NOT
-- EXISTS = no-op lá; em banco novo/restore, esta migração os recria. ADITIVA.
--
-- Migrations manuais, sem runner (NUNCA db push):
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 101_indices_ident_digitos.sql
-- ============================================================

-- staff_outbound_samples: casamento por dígitos (ident) — e a variante com received_at
-- p/ max()/janelas por ident sem sort extra.
CREATE INDEX IF NOT EXISTS idx_staff_extdigits
  ON lead_manager.staff_outbound_samples (tenant_id, regexp_replace(external_id, '[^0-9]', '', 'g'));
CREATE INDEX IF NOT EXISTS idx_staff_extdigits_recv
  ON lead_manager.staff_outbound_samples (regexp_replace(external_id, '[^0-9]', '', 'g'), received_at);

-- conversations: dígitos (ident) e o external_id CRU sozinho (o índice UNIQUE existente é
-- (tenant_id, channel, external_id) — não serve p/ lookup só por external_id).
CREATE INDEX IF NOT EXISTS idx_conv_extdigits
  ON lead_manager.conversations (tenant_id, regexp_replace(external_id, '[^0-9]', '', 'g'));
CREATE INDEX IF NOT EXISTS idx_conv_extid
  ON lead_manager.conversations (external_id);

-- messages: (conversation_id, role, received_at) — max(received_at) por conversa/role vira
-- index-only scan (o idx_messages_conversation existente não cobre role/received_at).
CREATE INDEX IF NOT EXISTS idx_messages_conv_role_recv
  ON lead_manager.messages (conversation_id, role, received_at);

-- ROLLBACK (manual):
--   DROP INDEX IF EXISTS lead_manager.idx_staff_extdigits, lead_manager.idx_staff_extdigits_recv,
--     lead_manager.idx_conv_extdigits, lead_manager.idx_conv_extid, lead_manager.idx_messages_conv_role_recv;
