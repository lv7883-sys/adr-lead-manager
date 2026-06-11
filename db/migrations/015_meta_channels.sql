-- ============================================================
-- E5: canais da Meta (Lead Ads / Instagram DM / Facebook Messenger).
-- RODAR COMO SUPERUSER postgres (ALTER em tenants, que é do postgres; leads é do
-- lead_manager_user mas roda junto sem problema).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 015_meta_channels.sql
-- ============================================================

-- Identidade dos leads vindos da Meta:
--   meta_leadgen_id : id do lead de um Lead Ad (idempotência do leadgen).
--   meta_psid       : Page-Scoped ID do usuário em DM (Messenger/IG) — leads de DM
--                     não têm telefone; é a chave de dedup deles.
ALTER TABLE lead_manager.leads
    ADD COLUMN IF NOT EXISTS meta_leadgen_id text,
    ADD COLUMN IF NOT EXISTS meta_psid       text;

CREATE UNIQUE INDEX IF NOT EXISTS leads_meta_leadgen_id_uq
    ON lead_manager.leads (tenant_id, meta_leadgen_id) WHERE meta_leadgen_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS leads_meta_psid_uq
    ON lead_manager.leads (tenant_id, meta_psid) WHERE meta_psid IS NOT NULL;

-- Credencial da Meta por tenant:
--   meta_page_id        : id da página FB (resolve tenant em Lead Ads/Messenger).
--   meta_ig_id          : id da conta Instagram (resolve tenant em IG DM — o webhook
--                         do IG manda entry.id = id da conta IG, ≠ id da página FB).
--   meta_page_token_enc : Page Access Token de longa duração, CIFRADO com a
--                         LM_ENCRYPTION_KEY (src/crypto.js — mesma chave do Evolution).
ALTER TABLE lead_manager.tenants
    ADD COLUMN IF NOT EXISTS meta_page_id        text,
    ADD COLUMN IF NOT EXISTS meta_ig_id          text,
    ADD COLUMN IF NOT EXISTS meta_page_token_enc text;

CREATE UNIQUE INDEX IF NOT EXISTS tenants_meta_page_id_uq
    ON lead_manager.tenants (meta_page_id) WHERE meta_page_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tenants_meta_ig_id_uq
    ON lead_manager.tenants (meta_ig_id) WHERE meta_ig_id IS NOT NULL;

-- Resolve o tenant pelo id do webhook (page_id FB OU conta IG) SEM contexto RLS (o
-- webhook /webhook/meta é uma URL única, sem tenant na path). SECURITY DEFINER (owned
-- by postgres), mesmo padrão de tenants_for_retention(). Só tenant com LM ativo.
CREATE OR REPLACE FUNCTION lead_manager.tenant_by_meta_page(p_page_id text)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = lead_manager AS $$
  SELECT id FROM lead_manager.tenants
   WHERE (meta_page_id = p_page_id OR meta_ig_id = p_page_id) AND lead_manager_active
   LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION lead_manager.tenant_by_meta_page(text) TO lead_manager_user;
