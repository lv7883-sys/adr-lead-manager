-- ============================================================
-- 081 — ADR-042 (E14 / B1): tipo da conversa (DIRECT/GROUP/COMMUNITY).
-- Permite o inbox distinguir grupos/comunidades de conversas 1:1. Grupos passam a ser
-- INGERIDOS pelo webhook com kind='GROUP' (antes eram descartados — webhook.js guard).
-- ADITIVA. Default 'DIRECT' (todas as conversas atuais são 1:1). Não surface nada sozinha
-- (a listagem do inbox ainda filtra @g.us — B2 é que mostra).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 081_conversation_kind.sql
-- ============================================================

ALTER TABLE lead_manager.conversations
  ADD COLUMN IF NOT EXISTS conversation_kind text NOT NULL DEFAULT 'DIRECT'
    CHECK (conversation_kind IN ('DIRECT', 'GROUP', 'COMMUNITY'));

-- ROLLBACK (manual):
--   ALTER TABLE lead_manager.conversations DROP COLUMN IF EXISTS conversation_kind;
