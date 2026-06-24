-- ============================================================================
-- 045_classificacao_pendente.sql — Resiliência a falha de IA (503/timeout) no
-- Portão 1. Lead novo cuja classificação falhou NÃO some no limbo nem vira
-- NOT_LEAD: entra num BUFFER visível ("aguardando classificação") e é
-- reprocessado pela CONVERSA INTEIRA (caminho classifyConversa) por tempo (job)
-- e por evento (nova mensagem). Esgotada a janela → Revisar + alerta ativo.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 045_classificacao_pendente.sql
--
-- NUMERAÇÃO: na main o topo é 042; 043 (lead_origem) e 044 (surface_a) já existem
-- em outras branches/no DB de prod — por isso 045, pra não colidir. Renumere se
-- a ordem de merge exigir. Aditiva e idempotente.
--
-- Estado novo de leads.status: 'PENDING_CLASSIFICATION' (sem CHECK na coluna —
-- status é texto livre). É um estado AUTOMÁTICO/transitório; some assim que a
-- reclassificação resolve (vira QUALIFYING/NOT_LEAD/REVIEW_QUEUE) ou a janela
-- estoura (vira REVIEW_QUEUE). Decisão humana (review_result/desfecho) tem
-- prioridade e nunca é sobrescrita por este fluxo.
-- ============================================================================

ALTER TABLE lead_manager.leads
    -- Início da janela de buffer (NULL = não está aguardando classificação).
    ADD COLUMN IF NOT EXISTS classification_pending_since timestamptz,
    -- Tentativas de reclassificação enquanto no buffer (diagnóstico/observabilidade).
    ADD COLUMN IF NOT EXISTS classification_attempts integer NOT NULL DEFAULT 0,
    -- Última falha de IA registrada (503/timeout) — diagnóstico.
    ADD COLUMN IF NOT EXISTS classification_last_error text;

-- Índice parcial: o job de reprocessamento varre só os leads no buffer.
CREATE INDEX IF NOT EXISTS idx_leads_pending_classification
    ON lead_manager.leads (tenant_id, classification_pending_since)
    WHERE status = 'PENDING_CLASSIFICATION';
