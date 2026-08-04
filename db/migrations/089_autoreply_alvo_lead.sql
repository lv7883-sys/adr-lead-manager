-- ============================================================
-- 089 — ADR-006+: Janis fora do horário com 2 chaves independentes — LEADS vs OUTRAS conversas.
-- Permite ligar/desligar a auto-resposta separadamente p/ conversas marcadas como LEAD e para
-- todas as demais (alunos atuais, contatos diversos). Default true nas DUAS (preserva o
-- comportamento atual — responder a todos); cada tenant ajusta na tela Automação.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 089_autoreply_alvo_lead.sql
-- ============================================================

ALTER TABLE lead_manager.automacao_config
  ADD COLUMN IF NOT EXISTS ia_fora_leads     boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS ia_fora_nao_leads boolean NOT NULL DEFAULT true;

-- ROLLBACK (manual):
--   ALTER TABLE lead_manager.automacao_config DROP COLUMN IF EXISTS ia_fora_leads, DROP COLUMN IF EXISTS ia_fora_nao_leads;
