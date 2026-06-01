-- ============================================================
-- E1-02 + E1-03 | Classificação de intenção e extração de dados do lead.
-- Executar como superuser "postgres".
-- ============================================================

-- ---- E1-02: intenção classificada do lead ----
ALTER TABLE lead_manager.leads ADD COLUMN IF NOT EXISTS intent text
    CHECK (intent IN ('SCHEDULE_INTEREST', 'PRICE_INQUIRY', 'GENERAL_INFO', 'OUT_OF_SCOPE'));

-- ---- E1-03: dados estruturados extraídos durante a conversa ----
CREATE TABLE IF NOT EXISTS lead_manager.lead_qualifications (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id              uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    lead_id                uuid NOT NULL REFERENCES lead_manager.leads(id) ON DELETE CASCADE,
    name                   text,   -- valor extraído, 'unclear' (após repergunta) ou null
    instrument             text,
    availability           text,
    qualification_complete boolean NOT NULL DEFAULT false,
    -- controle interno da regra "repergunta única": campos já reperguntados.
    reasked                text[] NOT NULL DEFAULT '{}',
    extracted_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, lead_id)
);

ALTER TABLE lead_manager.lead_qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.lead_qualifications FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.lead_qualifications;
CREATE POLICY tenant_isolation ON lead_manager.lead_qualifications
    USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON lead_manager.lead_qualifications TO lead_manager_user;
