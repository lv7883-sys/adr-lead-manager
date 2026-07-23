-- ============================================================
-- Fatia D — HIGIENE dos rascunhos PENDING (pending_approvals). DADOS, IDEMPOTENTE (rodar 2× ok).
-- Raiz: o Portão 2 (processInbound, engine.js) inseria um PENDING novo a cada inbound, SEM dedup
-- (o generateDraftForLead já dedupava). 427 PENDING p/ 102 leads (4,2/lead), 40% órfãos.
-- ARQUIVA (status='ARCHIVED', molde da migração 040) — NÃO deleta; a recepção já só via o mais
-- recente, então arquivar os antigos não muda a tela e desincha o "Backlog pendente" do BI.
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 074_pending_approvals_cleanup.sql
--
-- BACKUP antes (regra). ROLLBACK: não há (é reversível pontual — os arquivados guardam o texto;
--   reverter = UPDATE ... SET status='PENDING' pelos ids do backup, se preciso). Multi-tenant
--   (dedup por (tenant_id, lead_id)). CUIDADO Aline: reaberta = QUALIFYING (¬órfã) → PENDING dela
--   PRESERVADO (a purga só toca NOT_LEAD/REVIEW_QUEUE/terminal).
-- ============================================================

-- (1) DEDUP — arquiva os PENDING NÃO-mais-recentes por lead (mantém o mais recente = o que a
--     recepção vê). Idempotente: 2ª execução acha rn>1 = nenhum.
UPDATE lead_manager.pending_approvals SET status = 'ARCHIVED'
 WHERE status = 'PENDING'
   AND id IN (
     SELECT id FROM (
       SELECT id, row_number() OVER (
                     PARTITION BY tenant_id, lead_id
                     ORDER BY created_at DESC, id DESC) AS rn
         FROM lead_manager.pending_approvals
        WHERE status = 'PENDING'
     ) d
      WHERE d.rn > 1
   );

-- (2) PURGA ÓRFÃOS — arquiva PENDING de leads FORA do funil: NOT_LEAD/REVIEW_QUEUE OU TERMINAL
--     (CONVERTED/WON OU desfecho registrado — régua canônica da Fatia A). Lead reaberto
--     (QUALIFYING, desfecho NULL) NÃO é órfão → seu PENDING fica. Idempotente.
UPDATE lead_manager.pending_approvals pa SET status = 'ARCHIVED'
  FROM lead_manager.leads l
 WHERE pa.status = 'PENDING'
   AND pa.lead_id = l.id
   AND ( l.status IN ('NOT_LEAD','REVIEW_QUEUE','CONVERTED','WON')
      OR l.desfecho IS NOT NULL );
