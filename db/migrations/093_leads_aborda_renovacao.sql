-- ============================================================
-- 093 — TEMA RENOVAÇÃO pela IA (gate 0). O classificador de conversa (gemini.classifyConversa) passa
-- a devolver "aborda_renovacao" no MESMO prompt (custo-zero de chamada). Persistimos por lead, no
-- mesmo padrão de conversation_state (ADR-003 / migr. 036). O filtro da aba Renovações do inbox
-- passa a usar ESTA marca (interpretação da IA) no lugar do ILIKE '%renova%'.
--
-- NULL = ainda não computado (conversas antigas até o backfill rodar). ADITIVA, nullable.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 093_leads_aborda_renovacao.sql
-- ============================================================

ALTER TABLE lead_manager.leads ADD COLUMN IF NOT EXISTS aborda_renovacao boolean;

-- ROLLBACK (manual):
--   ALTER TABLE lead_manager.leads DROP COLUMN IF EXISTS aborda_renovacao;
