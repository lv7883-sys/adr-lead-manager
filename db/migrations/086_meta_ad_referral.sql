-- ============================================================
-- 086 — ADR-042/Meta: ATRIBUIÇÃO DE CAMPANHA nos DMs (Click-to-Messenger / Click-to-IG-Direct).
-- Quando alguém clica num anúncio "enviar mensagem", a Meta manda um objeto `referral`
-- (ad_id, ref, source, type, ads_context_data) junto do 1º contato — em messaging[].referral,
-- messaging[].postback.referral ou messaging[].message.referral. Guardamos cada toque aqui
-- (append-only), independente de a conversa já existir (o referral pode chegar antes da 1ª msg).
-- A ATRIBUIÇÃO (first-touch) de uma conversa = a linha MAIS ANTIGA por (channel, psid).
-- Redelivery do webhook NÃO duplica: índice único por (tenant, channel, psid, ad_id, ref).
-- DM orgânico (sem clique em anúncio) não gera linha — nada a atribuir.
-- ADITIVA. Executar como superuser "postgres" ANTES do rebuild:
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 086_meta_ad_referral.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_manager.meta_ad_referral (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
    channel      text NOT NULL,             -- 'facebook_messenger' | 'instagram_dm'
    psid         text NOT NULL,             -- sender.id do usuário (= conversations.external_id no canal Meta)
    ad_id        text,                      -- id do anúncio (resolve p/ campanha via Graph API, opcional)
    ref          text,                      -- código livre definido no anúncio (ex.: nome da campanha)
    source       text,                      -- ex.: 'ADS', 'SHORTLINK'
    ref_type     text,                      -- ex.: 'OPEN_THREAD'
    ads_context  jsonb,                     -- ads_context_data (título do anúncio, foto, post_id, ...)
    received_at  timestamptz NOT NULL DEFAULT now()
);

-- First-touch + idempotência: uma linha por (pessoa, anúncio, ref). Reentrega do webhook
-- e cliques repetidos no MESMO anúncio não duplicam (mantém o received_at mais antigo).
CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_ad_referral
    ON lead_manager.meta_ad_referral (tenant_id, channel, psid, (coalesce(ad_id, '')), (coalesce(ref, '')));
-- Lookup da atribuição por conversa (channel, psid) ordenando por received_at.
CREATE INDEX IF NOT EXISTS idx_meta_ad_referral_lookup
    ON lead_manager.meta_ad_referral (tenant_id, channel, psid, received_at);

ALTER TABLE lead_manager.meta_ad_referral ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.meta_ad_referral FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.meta_ad_referral;
CREATE POLICY tenant_isolation ON lead_manager.meta_ad_referral
    USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT ON lead_manager.meta_ad_referral TO lead_manager_user;

-- ROLLBACK (manual):
--   DROP TABLE IF EXISTS lead_manager.meta_ad_referral;
