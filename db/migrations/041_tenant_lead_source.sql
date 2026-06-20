-- ============================================================================
-- 041_tenant_lead_source.sql
-- Generaliza o mapa "entidade da plataforma -> tenant" (item 1 do arco multi-fonte).
--
-- Hoje (migr. 015) a resolução vive em colunas de `tenants` (meta_page_id / meta_ig_id)
-- e a função tenant_by_meta_page() casa qualquer uma das duas. Esta migration:
--   1. cria a tabela própria `tenant_lead_source` (platform, entity_id, field_map);
--   2. faz BACKFILL das páginas/contas já configuradas (paridade);
--   3. externaliza o field_map de domínio (música/ADR) que estava cravado em
--      metaIngest.js:15-29 -> vira dado na linha do tenant;
--   4. cria a função genérica tenant_by_lead_source() e transforma
--      tenant_by_meta_page() num WRAPPER fino sobre ela (callers ficam intactos).
--
-- ADITIVA: NÃO dropa nem renomeia nada. As colunas tenants.meta_page_id/meta_ig_id e
-- tenant_by_meta_page() continuam existindo. A token de página (meta_page_token_enc)
-- NÃO é tocada (continua em `tenants`, lida por pageCredsForTenant).
--
-- Só plataforma 'meta' agora. `platform` é forward-compat (Google/TikTok depois) —
-- ZERO infra dessas plataformas aqui.
--
-- RODAR COMO postgres (CREATE TABLE/FUNCTION SECURITY DEFINER, mesmo padrão da 015):
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 041_tenant_lead_source.sql
-- Idempotente.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tabela. entity_kind distingue page FB de conta IG (fidelidade às duas
--    colunas que tenant_by_meta_page casava). A chave de roteamento do webhook
--    é (platform, entity_id) — o entity_id vem no envelope do payload.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_manager.tenant_lead_source (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    platform     text NOT NULL DEFAULT 'meta',
    entity_kind  text NOT NULL DEFAULT 'fb_page',   -- 'fb_page' | 'ig_account'
    entity_id    text NOT NULL,
    field_map    jsonb,                              -- null => fallback ao default em código
    active       boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Roteamento do webhook: o entity_id é único por plataforma (mesma garantia das
-- UNIQUE de tenants.meta_page_id / meta_ig_id da migr. 015).
CREATE UNIQUE INDEX IF NOT EXISTS tenant_lead_source_platform_entity_uq
    ON lead_manager.tenant_lead_source (platform, entity_id);
-- Leitura do field_map por tenant (sob RLS, depois de resolver o tenant).
CREATE INDEX IF NOT EXISTS tenant_lead_source_tenant_idx
    ON lead_manager.tenant_lead_source (tenant_id, platform);

-- RLS: mesmo padrão de leads/lead_eventos. A leitura do field_map roda sob
-- withTenant (app.current_tenant). A RESOLUÇÃO de tenant NÃO usa RLS — vai pela
-- função SECURITY DEFINER abaixo (owner postgres bypassa RLS), antes do contexto.
ALTER TABLE lead_manager.tenant_lead_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.tenant_lead_source FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.tenant_lead_source;
CREATE POLICY tenant_isolation ON lead_manager.tenant_lead_source
    USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON lead_manager.tenant_lead_source TO lead_manager_user;

-- ---------------------------------------------------------------------------
-- 2. Backfill (aditivo, idempotente). Copia o que JÁ está em tenants. Sem essa
--    cópia o wrapper do passo 4 perderia paridade (a resolução passa a ler aqui).
-- ---------------------------------------------------------------------------
INSERT INTO lead_manager.tenant_lead_source (tenant_id, platform, entity_kind, entity_id)
SELECT id, 'meta', 'fb_page', meta_page_id
  FROM lead_manager.tenants
 WHERE meta_page_id IS NOT NULL
ON CONFLICT (platform, entity_id) DO NOTHING;

INSERT INTO lead_manager.tenant_lead_source (tenant_id, platform, entity_kind, entity_id)
SELECT id, 'meta', 'ig_account', meta_ig_id
  FROM lead_manager.tenants
 WHERE meta_ig_id IS NOT NULL
ON CONFLICT (platform, entity_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. field_map de domínio (paridade total com metaIngest.js:15-29).
--    Só faz sentido p/ Lead Ads (fb_page); DM (ig_account) não usa welcome/interesse.
--    O JSON abaixo é o ESPELHO EXATO do DEFAULT_FIELD_MAP em metaIngest.js — manter
--    os dois em sincronia. Comportamento idêntico: o ADR passa a vir de dado, não código.
--      - name_keys / name_compose_keys : f.full_name || f.name || (first+last)
--      - phone_keys                    : f.phone_number || f.phone
--      - interest_key_pattern          : heurística /instrument|instrumento/i sobre os NOMES dos campos
--      - welcome.*                     : "Olá! Vim pelo anúncio e tenho interesse[ em aula de X.| nas aulas.][ Meu nome é Y.]"
-- ---------------------------------------------------------------------------
UPDATE lead_manager.tenant_lead_source
   SET field_map = jsonb_build_object(
         'name_keys',         jsonb_build_array('full_name', 'name'),
         'name_compose_keys', jsonb_build_array('first_name', 'last_name'),
         'phone_keys',        jsonb_build_array('phone_number', 'phone'),
         'interest_key_pattern', 'instrument|instrumento',
         'welcome', jsonb_build_object(
            'prefix',           'Olá! Vim pelo anúncio e tenho interesse',
            'with_interest',    ' em aula de {interest}.',
            'without_interest', ' nas aulas.',
            'with_name',        ' Meu nome é {name}.'
         )
       ),
       updated_at = now()
 WHERE platform = 'meta' AND entity_kind = 'fb_page' AND field_map IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Resolver genérico + wrapper. SECURITY DEFINER (owner postgres) p/ rodar ANTES
--    do contexto RLS, igual tenant_by_meta_page original. JOIN em tenants preserva
--    a checagem lead_manager_active. `active` da fonte permite desligar sem apagar.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lead_manager.tenant_by_lead_source(p_platform text, p_entity_id text)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = lead_manager AS $$
  SELECT s.tenant_id
    FROM lead_manager.tenant_lead_source s
    JOIN lead_manager.tenants t ON t.id = s.tenant_id
   WHERE s.platform = p_platform
     AND s.entity_id = p_entity_id
     AND s.active
     AND t.lead_manager_active
   LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION lead_manager.tenant_by_lead_source(text, text) TO lead_manager_user;

-- tenant_by_meta_page vira WRAPPER fino -> caller em meta.js:107 fica INTOCADO.
-- Mesma assinatura (text)->uuid, mesma semântica (page FB OU conta IG = platform 'meta').
CREATE OR REPLACE FUNCTION lead_manager.tenant_by_meta_page(p_page_id text)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = lead_manager AS $$
  SELECT lead_manager.tenant_by_lead_source('meta', p_page_id);
$$;
GRANT EXECUTE ON FUNCTION lead_manager.tenant_by_meta_page(text) TO lead_manager_user;
