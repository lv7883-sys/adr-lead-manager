-- ============================================================================
-- 048_resources_datado.sql
-- ADR-025 (gestão de recursos) — EMENDA "fatia DATADA". Implementa os termos
-- EXCEÇÃO e o HISTÓRICO de ocupação do schema `resources`.
--
-- A OCUPAÇÃO NÃO É TABELA: por decisão da emenda do ADR-025 (decisão 1), a ocupação
-- é LIDA AO VIVO na Extranet (api-salas-grade.php) no momento da pergunta, sob o
-- pg_advisory_lock da Parte 3 (ADR-026), e DESCARTADA. NÃO existe occupation_snapshot
-- (nome do ADR-025 original ficou OBSOLETO) nem tabela de ocupação ao vivo.
--
-- ADITIVA e IDEMPOTENTE: só CREATE ... IF NOT EXISTS / DROP POLICY IF EXISTS. NÃO
-- altera nada do schema lead_manager nem das tabelas já existentes do schema resources.
-- ESPELHA o padrão da 046/047 (PK uuid gen_random_uuid; tenant_id NOT NULL FK CASCADE;
-- RLS ENABLE+FORCE + policy tenant_isolation por app.current_tenant; GRANTs ao role da app).
--
-- DEPENDE de 046 (resources.resource, resources.capability, resources.resource_source_binding).
--
-- RODAR COMO postgres (migrations manuais, sem runner; ver memória):
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 048_resources_datado.sql
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. resource_exception — termo EXCEÇÃO (dado estável, persiste).
--    resource_id NULL = vale pra escola TODA (ex.: feriado); preenchido = professor
--    /sala específico. Distinto de ocupação: ocupação = "tomado por aula" (libera se
--    cancela); exceção = "bloqueado, nenhuma aula possível" (feriado/férias/manutenção).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resources.resource_exception (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    resource_id        uuid REFERENCES resources.resource(id) ON DELETE CASCADE,   -- NULL = tenant-wide
    starts_at          timestamptz NOT NULL,
    ends_at            timestamptz NOT NULL,
    type               text NOT NULL CHECK (type IN ('HOLIDAY','VACATION','MAINTENANCE','CLOSURE')),
    reason             text,
    source_binding_id  uuid REFERENCES resources.resource_source_binding(id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS resource_exception_tenant_resource_starts_idx
    ON resources.resource_exception (tenant_id, resource_id, starts_at);

-- ---------------------------------------------------------------------------
-- 2. occupation_history — HISTÓRICO de ocupação p/ GESTÃO. APPEND-ONLY, DIFF-BASED.
--    Cada MUDANÇA de estado de um slot recorrente vira UMA LINHA NOVA (nunca update/
--    delete — append-only é CONVENÇÃO da app: o runner só INSERE quando o estado muda).
--    GENÉRICO: o nível é capability × recurso × slot — NÃO crava "instrumento"; cada
--    painel agrega como o nicho pede na LEITURA (música→instrumento, etc. — fronteira
--    anti-vazamento). Permite ao gestor ver a EVOLUÇÃO da ocupação ao longo do tempo.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resources.occupation_history (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    resource_id    uuid NOT NULL REFERENCES resources.resource(id)   ON DELETE CASCADE,
    capability_id  uuid NOT NULL REFERENCES resources.capability(id) ON DELETE CASCADE,
    weekday        smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
    slot_time      time NOT NULL,                       -- horário recorrente do slot
    occupied       boolean NOT NULL,                    -- novo estado: true=ocupado, false=livre
    changed_at     timestamptz NOT NULL DEFAULT now()
);
-- Série temporal por slot + "último registro de cada slot" (changed_at DESC = topo).
CREATE INDEX IF NOT EXISTS occupation_history_slot_changed_idx
    ON resources.occupation_history (tenant_id, resource_id, capability_id, weekday, slot_time, changed_at DESC);

-- ---------------------------------------------------------------------------
-- 3. RLS em TODAS as tabelas novas. ENABLE + FORCE + policy por tenant via
--    app.current_tenant. Mesmo padrão de 046/047.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'resource_exception',
    'occupation_history'
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
-- 4. Privilégios para o role da app (iguais aos da 046; explícito por idempotência —
--    o ALTER DEFAULT PRIVILEGES da 046 já cobre tabelas novas).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON resources.resource_exception  TO lead_manager_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON resources.occupation_history  TO lead_manager_user;
