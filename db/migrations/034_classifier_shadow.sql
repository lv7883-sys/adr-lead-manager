-- ============================================================================
-- Fase 1 do classificador — SHADOW / log-only. ZERO mudança no funil.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 034_classifier_shadow.sql
--
-- Hoje, quando a conversa já está estabelecida (existe staff_outbound), o Portão 1
-- é PULADO e o lead auto-promove pra QUALIFYING (engine.js ~355). Essa tabela registra
-- o que o classificador ATUAL DECIDIRIA nessas conversas (braço de CONTROLE, msg
-- isolada) — pra validar com dado real ANTES de flipar o skip. Nada aqui altera o
-- comportamento do funil: o lead continua promovendo via skip exatamente como hoje.
--
--   shadow_decision pelos thresholds atuais (engine.js):
--     >= 0.85  -> 'would_promote'
--     >= 0.40  -> 'would_review'
--     <  0.40  -> 'would_reject'
--   acao_real    = o que o funil DE FATO fez nesse turno (sempre 'skip_promote' por ora)
--   ground_truth = rótulo humano, preenchido DEPOIS na análise (lead real x falso-positivo)
--
-- Aditiva e idempotente. Segue o modelo de isolamento do schema (RLS FORCE por tenant).
-- ============================================================================

CREATE TABLE IF NOT EXISTS lead_manager.classifier_shadow (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant               uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    lead_id              uuid REFERENCES lead_manager.leads(id) ON DELETE SET NULL,
    telefone             text,
    msg_body             text,
    conversa_estabelecida boolean NOT NULL DEFAULT true,
    acao_real            text NOT NULL DEFAULT 'skip_promote',
    shadow_score         double precision,
    shadow_decision      text,   -- 'would_promote' | 'would_review' | 'would_reject'
    shadow_intent        text,
    ground_truth         text,   -- preenchido depois, na análise
    created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_classifier_shadow_tenant_created
    ON lead_manager.classifier_shadow (tenant, created_at);
CREATE INDEX IF NOT EXISTS idx_classifier_shadow_lead
    ON lead_manager.classifier_shadow (lead_id);

-- RLS: mesmo modelo das demais tabelas (isolamento por app.current_tenant).
-- O superuser postgres ignora RLS, então a análise posterior via psql lê tudo.
ALTER TABLE lead_manager.classifier_shadow ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.classifier_shadow FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON lead_manager.classifier_shadow;
CREATE POLICY tenant_isolation ON lead_manager.classifier_shadow
    USING      (tenant = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON lead_manager.classifier_shadow TO lead_manager_user;
