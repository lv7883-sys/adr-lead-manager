-- ============================================================
-- G (dashboard de gestão) — quando/quem decidiu a aprovação, para métricas de
-- tempo rascunho->decisão. Population a partir de agora (linhas antigas ficam null).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 017_pending_approvals_decided.sql
-- ============================================================

ALTER TABLE lead_manager.pending_approvals
    ADD COLUMN IF NOT EXISTS decided_at timestamptz;

-- Identidade de quem decidiu. Hoje grava o papel (service/RECEPCAO) — a identidade
-- nominativa da recepcionista vem na Fase 1b (plumbing do usuário do dashboard).
ALTER TABLE lead_manager.pending_approvals
    ADD COLUMN IF NOT EXISTS decided_by text;
