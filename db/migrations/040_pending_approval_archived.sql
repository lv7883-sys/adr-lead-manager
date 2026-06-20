-- ============================================================================
-- RASCUNHO ARQUIVADO (reconciliar "rascunhos" com a fila de ação).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 040_pending_approval_archived.sql
--
-- Um rascunho (pending_approval) é uma RESPOSTA PRONTA para um lead que precisa de
-- resposta — logicamente um SUBCONJUNTO da fila de ação. Rascunhos pendentes de leads que
-- NÃO estão AGUARDANDO_RECEPCAO (RESOLVIDO / AGUARDANDO_CLIENTE / lead já terminal) são
-- STALE: viram ruído no "X aguardando aprovação". Em vez de DELETAR (perde histórico),
-- ganham o status ARCHIVED — saem de todos os contadores (que filtram status='PENDING')
-- mas a linha + suggested_response continuam para auditoria/revert.
--
-- Aditiva e idempotente.
-- ============================================================================

ALTER TABLE lead_manager.pending_approvals
    DROP CONSTRAINT IF EXISTS pending_approvals_status_check;

ALTER TABLE lead_manager.pending_approvals
    ADD CONSTRAINT pending_approvals_status_check
        CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EDITED', 'ARCHIVED'));
