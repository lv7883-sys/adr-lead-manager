-- ============================================================================
-- Histórico/timeline por lead (append-only) — unificação Etapa & anotações.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 037_lead_eventos.sql
--
-- Cada mudança de ETAPA (kanban, via drag OU dropdown do card de detalhe) e cada
-- ANOTAÇÃO da recepção viram uma linha aqui. `etapa_key` guarda a chave ESTÁVEL da
-- etapa (forward-compat: a IA vai sugerir entre elas depois). Reativação (terminal→
-- não-terminal) registra o desfecho anterior em `conteudo` — limpar não perde dado.
--
-- Tenant-scoped (RLS), append-only. Aditiva e idempotente.
-- ============================================================================

CREATE TABLE IF NOT EXISTS lead_manager.lead_eventos (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    lead_id     uuid NOT NULL REFERENCES lead_manager.leads(id)  ON DELETE CASCADE,
    tipo        text NOT NULL,            -- 'mudanca_etapa' | 'nota'
    autor       text,                     -- papel/usuário que registrou
    conteudo    text,                     -- texto da nota OU descrição da transição
    etapa_key   text,                     -- chave estável da etapa (quando mudanca_etapa)
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_eventos_lead_idx
    ON lead_manager.lead_eventos (tenant_id, lead_id, created_at DESC);

ALTER TABLE lead_manager.lead_eventos ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.lead_eventos FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.lead_eventos;
CREATE POLICY tenant_isolation ON lead_manager.lead_eventos
    USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT ON lead_manager.lead_eventos TO lead_manager_user;
