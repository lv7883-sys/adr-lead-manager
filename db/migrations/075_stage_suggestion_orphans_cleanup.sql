-- ============================================================
-- Fatia (b) — HIGIENE das sugestões de etapa da IA ÓRFÃS. ADITIVA + IDEMPOTENTE (rodar 2× não quebra).
--
-- PROBLEMA: quando um lead é descartado (NOT_LEAD/REVIEW_QUEUE) ou vira terminal (desfecho definido),
-- a suggested_stage pendente NÃO era limpa → sugestões fantasma poluem o contador e a base (46 hoje:
-- 33 NOT_LEAD + 13 com desfecho). A RAIZ foi corrigida no código (_limparSugestaoEtapa roda junto no
-- descarte/terminal); esta migração zera o PASSIVO acumulado.
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 075_stage_suggestion_orphans_cleanup.sql
--
-- NÃO deleta cego: SNAPSHOT das linhas afetadas antes de anular (molde do sweep-stage-suggestion e
-- das migrações 073/074). Multi-tenant: age em TODAS as linhas (sem franquia_id cravado). Só anula a
-- SUGESTÃO (3 colunas) — preserva suggested_stage_dismissed (memória de dispensa) e todo o resto.
-- ROLLBACK: UPDATE ... FROM bkp_stage_suggestion_orphans_20260723 (comando impresso no fim).
-- ============================================================

BEGIN;

-- (1) SNAPSHOT (idempotente: cria a tabela 1×, insere só o que ainda não está lá).
CREATE TABLE IF NOT EXISTS lead_manager.bkp_stage_suggestion_orphans_20260723 (
  id                 uuid,
  tenant_id          uuid,
  status             text,
  desfecho           text,
  suggested_stage    text,
  stage_reasoning    text,
  stage_suggested_at timestamptz,
  snap_at            timestamptz
);

INSERT INTO lead_manager.bkp_stage_suggestion_orphans_20260723
  SELECT l.id, l.tenant_id, l.status, l.desfecho, l.suggested_stage, l.stage_reasoning, l.stage_suggested_at, now()
    FROM lead_manager.leads l
   WHERE l.suggested_stage IS NOT NULL
     AND (l.status IN ('NOT_LEAD', 'REVIEW_QUEUE') OR l.desfecho IS NOT NULL)
     AND l.id NOT IN (SELECT b.id FROM lead_manager.bkp_stage_suggestion_orphans_20260723 b);

-- (2) ANULA a sugestão órfã (lead terminal/descartado). Não toca updated_at (mudança invisível) nem
--     suggested_stage_dismissed. Idempotente: 2ª execução não encontra mais órfãs.
UPDATE lead_manager.leads l
   SET suggested_stage = NULL, stage_reasoning = NULL, stage_suggested_at = NULL
 WHERE l.suggested_stage IS NOT NULL
   AND (l.status IN ('NOT_LEAD', 'REVIEW_QUEUE') OR l.desfecho IS NOT NULL);

COMMIT;

-- ROLLBACK (restaura do snapshot):
--   UPDATE lead_manager.leads l
--      SET suggested_stage = b.suggested_stage, stage_reasoning = b.stage_reasoning, stage_suggested_at = b.stage_suggested_at
--     FROM lead_manager.bkp_stage_suggestion_orphans_20260723 b
--    WHERE b.id = l.id;
--   DROP TABLE lead_manager.bkp_stage_suggestion_orphans_20260723;
