-- ============================================================================
-- 046_resources_recorrente.sql
-- ADR-025 (gestão de recursos reserváveis multi-tenant) — FATIA RECORRENTE.
-- Cria o schema `resources` e o termo RECORRENTE do modelo canônico (E.1–E.4 da
-- Emenda do ADR-025). Disponibilidade como INTERVALOS, sem slot (DP-B).
--
-- ADITIVA e IDEMPOTENTE: só CREATE ... IF NOT EXISTS / DROP POLICY IF EXISTS.
-- NÃO dropa nem altera nada do schema lead_manager.
--
-- ESPELHA o padrão do lead_manager (migr. 001/041):
--   - PK uuid DEFAULT gen_random_uuid()
--   - tenant_id uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE
--   - RLS ENABLE + FORCE; policy tenant_isolation por app.current_tenant
--   - GRANTs ao role da app lead_manager_user (sem BYPASSRLS)
--
-- NÃO inclui occupation_snapshot nem resource_exception (fatia DATADA -> 047).
-- NÃO cria tabela "occupation_source" (é contrato de código — aviso E.3 do ADR).
-- NÃO semeia Valinhos (seed = config-como-dado, passo separado, não DDL).
--
-- RODAR COMO postgres (migrations manuais, sem runner; ver memória):
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 046_resources_recorrente.sql
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Schema próprio, de posse do usuário da aplicação (igual lead_manager).
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS resources AUTHORIZATION lead_manager_user;
GRANT USAGE ON SCHEMA resources TO lead_manager_user;

-- ---------------------------------------------------------------------------
-- 1. resource_source_binding — FUNDAÇÃO de proveniência (DP-D).
--    Projeção, no domínio de recursos, do painel de Conexões. `config` guarda o
--    ciphertext/json (cifragem em app-layer — MESMO modelo do token Meta).
--    Referenciada pelas demais tabelas (criada primeiro).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resources.resource_source_binding (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    kind        text NOT NULL CHECK (kind IN ('SCRAPE_EXTRANET','NATIVE','API')),
    name        text,
    config      jsonb,                                  -- credenciais cifradas em app-layer
    status      text NOT NULL DEFAULT 'ACTIVE',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resource_source_binding_tenant_idx
    ON resources.resource_source_binding (tenant_id);

-- ---------------------------------------------------------------------------
-- 2. resource — recurso reservável canônico (DP-A).
--    type extensível (sem enum cravado). provider_id/asset_id = RESERVA M2 p/
--    reconciliar com regente_core (ADR-007) — SÓ colunas, sem FK agora.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resources.resource (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    type               text NOT NULL,                  -- ex. 'ROOM','TEACHER' (extensível)
    external_ref       text,                           -- id na fonte; null = recurso nativo
    name               text NOT NULL,
    attributes         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- vocação da sala etc.
    provider_id        uuid,                           -- reserva M2 (sem FK)
    asset_id           uuid,                           -- reserva M2 (sem FK)
    source_binding_id  uuid REFERENCES resources.resource_source_binding(id) ON DELETE SET NULL,
    active             boolean NOT NULL DEFAULT true,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);
-- Dedupe de scrape: um external_ref por (tenant,type). Parcial — recurso nativo
-- (external_ref NULL) não colide.
CREATE UNIQUE INDEX IF NOT EXISTS resource_tenant_type_extref_uq
    ON resources.resource (tenant_id, type, external_ref)
    WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS resource_tenant_type_idx
    ON resources.resource (tenant_id, type);

-- ---------------------------------------------------------------------------
-- 3. capability — chave de compatibilidade, GENÉRICA (DP-F: instrumento p/
--    Valinhos; modalidade/especialidade p/ outros nichos).
--    Overrides DP-G: passo != duracao; herdam o default do tenant se NULL.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resources.capability (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id                 uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    external_ref              text,                     -- curso na fonte
    name                      text NOT NULL,
    source_binding_id         uuid REFERENCES resources.resource_source_binding(id) ON DELETE SET NULL,
    duration_minutes_override int,                      -- DP-G: ex. "Banda" = 90; NULL herda tenant
    step_minutes_override     int,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS capability_tenant_extref_uq
    ON resources.capability (tenant_id, external_ref)
    WHERE external_ref IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. resource_capability — UMA tabela resolve DOIS cruzamentos:
--    competência (professor<->capability) E vocação (sala<->capability).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resources.resource_capability (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    resource_id    uuid NOT NULL REFERENCES resources.resource(id)   ON DELETE CASCADE,
    capability_id  uuid NOT NULL REFERENCES resources.capability(id) ON DELETE CASCADE,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, resource_id, capability_id)
);
-- Busca "recursos que atendem a capability X" (lado do motor de interseção).
CREATE INDEX IF NOT EXISTS resource_capability_tenant_cap_idx
    ON resources.resource_capability (tenant_id, capability_id);

-- ---------------------------------------------------------------------------
-- 5. resource_availability — termo RECORRENTE. INTERVALOS, sem slot (DP-B).
--    weekday 1=segunda .. 7=domingo (Valinhos usa 1..6).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resources.resource_availability (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    resource_id        uuid NOT NULL REFERENCES resources.resource(id) ON DELETE CASCADE,
    weekday            smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
    start_time         time NOT NULL,
    end_time           time NOT NULL,
    source_binding_id  uuid REFERENCES resources.resource_source_binding(id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CHECK (end_time > start_time)
);
CREATE INDEX IF NOT EXISTS resource_availability_tenant_resource_weekday_idx
    ON resources.resource_availability (tenant_id, resource_id, weekday);

-- ---------------------------------------------------------------------------
-- 6. tenant_resource_config — bordas de OFERTA (defaults do tenant). 1 linha/tenant.
--    PASSO != DURAÇÃO; ambos sobrescritíveis por capability (tabela 3, DP-G).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resources.tenant_resource_config (
    tenant_id                 uuid PRIMARY KEY REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    default_slot_step_minutes int NOT NULL,
    default_duration_minutes  int NOT NULL,
    working_days              smallint[],               -- ex. '{1,2,3,4,5,6}'
    working_hours             jsonb,                    -- ex. {"start":"08:00","end":"22:00"}
    week_start                smallint NOT NULL DEFAULT 1,
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 7. RLS em TODAS as tabelas (inclusive vínculo). ENABLE + FORCE + policy por
--    tenant via app.current_tenant. Mesmo padrão de lead_manager (001/041).
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'resource_source_binding',
    'resource',
    'capability',
    'resource_capability',
    'resource_availability',
    'tenant_resource_config'
  ] LOOP
    EXECUTE format('ALTER TABLE resources.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE resources.%I FORCE  ROW LEVEL SECURITY;', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON resources.%I;', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON resources.%I
        USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
    $p$, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 8. Privilégios para o role da app (iguais aos de lead_manager).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES   IN SCHEMA resources TO lead_manager_user;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA resources TO lead_manager_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA resources
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO lead_manager_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA resources
    GRANT USAGE, SELECT                  ON SEQUENCES TO lead_manager_user;

-- ---------------------------------------------------------------------------
-- 9. Índice p/ os caminhos de busca por tipo de recurso (listar todos os
--    professores / todas as salas; split por tipo na busca por capability).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_resource_tenant_type_active
    ON resources.resource (tenant_id, type, active);
