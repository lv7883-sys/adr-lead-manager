-- ============================================================================
-- 044_surface_a_progressao.sql — Surface A (ADR-022): consumidor do evento
-- canônico de progressão (experimental_realizada / matricula_confirmada).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 044_surface_a_progressao.sql
--
-- Aditiva e idempotente. Inclui o hardening multi-tenant do ADR §8/§9:
--   - extranet_unit_map: unidade→tenant, SEM fallback (órfão é rejeitado no app).
--   - progressao_event_ledger: idempotência por (tenant, adapter, registro, situação).
--   - lead_eval_label: ground-truth positivo do recall (Mecanismo 2).
--   - colunas no leads: student_name, trava manual, proveniência/ator, origem.
-- ============================================================================

-- ── Mapa unidade→tenant (ADR §8.2). SEM RLS: é resolvido ANTES de saber o tenant.
-- Órfão (unidade fora do mapa) é REJEITADO + LOGADO no app, nunca cai em Valinhos.
CREATE TABLE IF NOT EXISTS lead_manager.extranet_unit_map (
    id_unidade_extranet text PRIMARY KEY,
    tenant_id           uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    slug                text,
    ativo               boolean NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now()
);
-- Seed: Valinhos como 1ª linha (unidade 13 da Extranet → tenant ADR Valinhos).
INSERT INTO lead_manager.extranet_unit_map (id_unidade_extranet, tenant_id, slug)
VALUES ('13', 'ed731a58-62e5-45ad-acba-a5502ff39e92', 'valinhos')
ON CONFLICT (id_unidade_extranet) DO NOTHING;
GRANT SELECT ON lead_manager.extranet_unit_map TO lead_manager_user;

-- ── Ledger de idempotência (ADR §9.4). Chave: registro-da-fonte + situação.
CREATE TABLE IF NOT EXISTS lead_manager.progressao_event_ledger (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    source_adapter   text NOT NULL,             -- 'extranet' | 'bi' | 'regente' | ...
    source_record_id text NOT NULL,             -- id estável do registro na fonte
    situacao         text NOT NULL,             -- estado/situação do registro na fonte
    tipo             text NOT NULL,             -- 'experimental_realizada' | 'matricula_confirmada'
    lead_id          uuid REFERENCES lead_manager.leads(id) ON DELETE SET NULL,
    resultado        text,                       -- advanced|concluded|walk_in|walk_in_concluded|review|locked_skip
    created_at       timestamptz NOT NULL DEFAULT now()
);
-- Idempotência como UNIQUE CONSTRAINT (não só índice): a chave (tenant, adapter,
-- registro, situação) é garantida no banco — reprocessar o mesmo evento não duplica
-- nem re-progride. Idempotente e auto-migra um índice homônimo pré-existente.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'progressao_ledger_uq'
    ) THEN
        DROP INDEX IF EXISTS lead_manager.progressao_ledger_uq;
        ALTER TABLE lead_manager.progressao_event_ledger
            ADD CONSTRAINT progressao_ledger_uq
            UNIQUE (tenant_id, source_adapter, source_record_id, situacao);
    END IF;
END $$;
ALTER TABLE lead_manager.progressao_event_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.progressao_event_ledger FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.progressao_event_ledger;
CREATE POLICY tenant_isolation ON lead_manager.progressao_event_ledger
    USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_manager.progressao_event_ledger TO lead_manager_user;

-- ── Ground-truth positivo do recall (Mecanismo 2 — lead_eval_label).
CREATE TABLE IF NOT EXISTS lead_manager.lead_eval_label (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    lead_id       uuid REFERENCES lead_manager.leads(id) ON DELETE SET NULL,
    label         text NOT NULL,                -- 'lead' | 'not_lead'
    source        text NOT NULL,                -- 'derived_funnel' | 'sample_audit' | 'recep_feedback'
    trigger       text,                          -- evento/ação que gerou o rótulo
    ai_routed_to  text,                          -- snapshot do que a IA decidira (recall não-circular)
    by            text,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_eval_label_tenant_idx
    ON lead_manager.lead_eval_label (tenant_id, created_at);
ALTER TABLE lead_manager.lead_eval_label ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.lead_eval_label FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.lead_eval_label;
CREATE POLICY tenant_isolation ON lead_manager.lead_eval_label
    USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_manager.lead_eval_label TO lead_manager_user;

-- ── Colunas no leads (ADR §9). leads é do owner postgres; ALTER roda como postgres.
-- `origem` é ADD IF NOT EXISTS para a branch ser auto-contida (a migration 043, em
-- outra branch/prod, também a cria — IF NOT EXISTS evita colisão).
ALTER TABLE lead_manager.leads
    ADD COLUMN IF NOT EXISTS origem               text,
    ADD COLUMN IF NOT EXISTS student_name         text,    -- nome do ALUNO, separado do contato
    ADD COLUMN IF NOT EXISTS auto_progress_locked boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS progressao_source    text,    -- 'system' | user id/role
    ADD COLUMN IF NOT EXISTS progressao_adapter   text;    -- adapter que progrediu
