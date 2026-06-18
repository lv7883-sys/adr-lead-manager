-- ============================================================================
-- REMEDIAÇÃO do latch de status (BUG 2) — leads travados em NOT_LEAD/REVIEW_QUEUE
-- que na verdade são leads reais (a recepção já respondeu E/OU confiança >= 0.85).
--
-- *** NÃO RODAR antes do deploy do código (engine.js) ***
-- Sem o fix de código, um novo inbound desses leads pode re-travar o status.
--
-- Critério CONSERVADOR:
--   status IN ('NOT_LEAD','REVIEW_QUEUE')
--   AND review_result IS NULL              (preserva decisão HUMANA explícita)
--   AND telefone real, 10–15 dígitos       (EXCLUI JIDs de grupo 120363…)
--   AND ( confiança >= 0.85  OR  staff_outbound existe )
-- Status novo proposto: 'QUALIFYING' (espelha o resgate do Portão 2) + review_queue=false.
--
-- Uso:
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 2026-06-17_remediacao_latch.sql
--   A SEÇÃO A (preview) é só leitura. A SEÇÃO B roda em transação com ROLLBACK
--   por padrão (dry-run): NÃO altera nada. Para efetivar, troque ROLLBACK por COMMIT.
-- ============================================================================

\set tenant '''ed731a58-62e5-45ad-acba-a5502ff39e92'''

-- ----------------------------------------------------------------------------
-- SEÇÃO A — PREVIEW (SOMENTE LEITURA)
-- ----------------------------------------------------------------------------
SELECT 'A) Preview dos leads elegíveis à remediação' AS secao;

WITH elegiveis AS (
  SELECT l.id, l.name, l.phone, l.meta_psid, l.status,
         l.classification_confidence AS confianca,
         (SELECT count(*) FROM lead_manager.staff_outbound_samples s
           WHERE s.tenant_id = l.tenant_id
             AND regexp_replace(s.external_id,'[^0-9]','','g')
                 = regexp_replace(coalesce(l.phone, l.meta_psid,''),'[^0-9]','','g')
             AND coalesce(s.raw->'data'->'key'->>'remoteJid','') NOT LIKE '%@g.us'
         ) AS qtd_staff_out
    FROM lead_manager.leads l
   WHERE l.tenant_id = :tenant
     AND l.status IN ('NOT_LEAD','REVIEW_QUEUE')
     AND l.review_result IS NULL
     AND length(regexp_replace(coalesce(l.phone, l.meta_psid,''),'[^0-9]','','g')) BETWEEN 10 AND 15
)
SELECT id, name, phone, status AS status_atual, confianca, qtd_staff_out,
       'QUALIFYING' AS status_novo_proposto
  FROM elegiveis
 WHERE confianca >= 0.85 OR qtd_staff_out > 0
 ORDER BY confianca DESC NULLS LAST, qtd_staff_out DESC;

SELECT 'A) Total elegível' AS secao,
       count(*) AS n
  FROM lead_manager.leads l
 WHERE l.tenant_id = :tenant
   AND l.status IN ('NOT_LEAD','REVIEW_QUEUE')
   AND l.review_result IS NULL
   AND length(regexp_replace(coalesce(l.phone, l.meta_psid,''),'[^0-9]','','g')) BETWEEN 10 AND 15
   AND ( l.classification_confidence >= 0.85
         OR EXISTS (SELECT 1 FROM lead_manager.staff_outbound_samples s
                     WHERE s.tenant_id = l.tenant_id
                       AND regexp_replace(s.external_id,'[^0-9]','','g')
                           = regexp_replace(coalesce(l.phone, l.meta_psid,''),'[^0-9]','','g')
                       AND coalesce(s.raw->'data'->'key'->>'remoteJid','') NOT LIKE '%@g.us') );

-- ----------------------------------------------------------------------------
-- SEÇÃO B — APPLY (DRY-RUN por padrão: BEGIN…ROLLBACK)
--   Roda o snapshot + UPDATE numa transação e DESFAZ no fim. Mostra os counts
--   sem alterar dados. Para EFETIVAR: troque o ROLLBACK final por COMMIT.
-- ----------------------------------------------------------------------------
BEGIN;

-- Snapshot p/ rollback (persiste junto com o UPDATE quando você der COMMIT).
CREATE TABLE IF NOT EXISTS lead_manager.bkp_latch_remediacao_20260617 (
  lead_id          uuid,
  status_antigo    text,
  review_queue_old boolean,
  snapshot_em      timestamptz DEFAULT now()
);

INSERT INTO lead_manager.bkp_latch_remediacao_20260617 (lead_id, status_antigo, review_queue_old)
SELECT l.id, l.status, l.review_queue
  FROM lead_manager.leads l
 WHERE l.tenant_id = :tenant
   AND l.status IN ('NOT_LEAD','REVIEW_QUEUE')
   AND l.review_result IS NULL
   AND length(regexp_replace(coalesce(l.phone, l.meta_psid,''),'[^0-9]','','g')) BETWEEN 10 AND 15
   AND ( l.classification_confidence >= 0.85
         OR EXISTS (SELECT 1 FROM lead_manager.staff_outbound_samples s
                     WHERE s.tenant_id = l.tenant_id
                       AND regexp_replace(s.external_id,'[^0-9]','','g')
                           = regexp_replace(coalesce(l.phone, l.meta_psid,''),'[^0-9]','','g')
                       AND coalesce(s.raw->'data'->'key'->>'remoteJid','') NOT LIKE '%@g.us') );

SELECT 'B) Snapshot gravado (linhas)' AS secao, count(*) AS n
  FROM lead_manager.bkp_latch_remediacao_20260617;

-- UPDATE de remediação (mesmo critério do snapshot).
UPDATE lead_manager.leads l
   SET status = 'QUALIFYING', review_queue = false, updated_at = now()
 WHERE l.tenant_id = :tenant
   AND l.status IN ('NOT_LEAD','REVIEW_QUEUE')
   AND l.review_result IS NULL
   AND length(regexp_replace(coalesce(l.phone, l.meta_psid,''),'[^0-9]','','g')) BETWEEN 10 AND 15
   AND ( l.classification_confidence >= 0.85
         OR EXISTS (SELECT 1 FROM lead_manager.staff_outbound_samples s
                     WHERE s.tenant_id = l.tenant_id
                       AND regexp_replace(s.external_id,'[^0-9]','','g')
                           = regexp_replace(coalesce(l.phone, l.meta_psid,''),'[^0-9]','','g')
                       AND coalesce(s.raw->'data'->'key'->>'remoteJid','') NOT LIKE '%@g.us') );

-- DRY-RUN: desfaz tudo. Para efetivar, comente o ROLLBACK e descomente o COMMIT.
ROLLBACK;
-- COMMIT;

-- ----------------------------------------------------------------------------
-- ROLLBACK MANUAL (se precisar reverter DEPOIS de um COMMIT):
--   UPDATE lead_manager.leads l
--      SET status = b.status_antigo, review_queue = b.review_queue_old, updated_at = now()
--     FROM lead_manager.bkp_latch_remediacao_20260617 b
--    WHERE l.id = b.lead_id;
-- ----------------------------------------------------------------------------
