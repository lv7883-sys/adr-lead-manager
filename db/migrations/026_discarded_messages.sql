-- ============================================================
-- ADR-019 — mensagens descartadas pelo gate0 (contato interno) passam a ser
-- salvas (não some nada). Alimenta a aba "Não classificadas".
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 026_discarded_messages.sql
-- ============================================================

ALTER TABLE lead_manager.messages
  ADD COLUMN IF NOT EXISTS discarded boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS discard_reason text;
