-- ============================================================================
-- 043 — Origem IMUTÁVEL do lead (first-touch) + backfill.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 043_lead_origem.sql
--
-- DECISÃO TRAVADA: origem = PRIMEIRO TOQUE, gravada UMA vez na criação e NUNCA
-- atualizada. Toque posterior de outro canal vira EVENTO (lead_eventos), não
-- re-origina. Valores: meta_lead_ads | whatsapp | instagram_dm | facebook_messenger
-- | organico (forward-compat: google | tiktok). Genérica e tenant-scoped.
--
-- PAYOFF: o badge do card e o recorte de FONTE das métricas passam a LER leads.origem
-- (estável) em vez do canal da conversa mais recente (que migra pra WhatsApp no 1º reply
-- e credita ao WhatsApp uma conversão que veio do Meta).
--
-- Aditiva e idempotente. RLS herdada da tabela. Coluna sob lead_manager_user.
-- ============================================================================

ALTER TABLE lead_manager.leads
    ADD COLUMN IF NOT EXISTS origem text;

-- Filtro de fonte nas métricas percorre origem.
CREATE INDEX IF NOT EXISTS idx_leads_origem
    ON lead_manager.leads (tenant_id, origem) WHERE origem IS NOT NULL;

-- ---------------------------------------------------------------------------
-- BACKFILL (one-shot, idempotente: só preenche origem NULL).
-- origem = canal da conversa MAIS ANTIGA do lead (first-touch). Fallbacks pra
-- leads sem conversa: meta_leadgen_id → meta_lead_ads; meta_psid → DM; senão whatsapp.
--
-- ⚠️ SNAPSHOT ANTES (rodar fora deste arquivo, no procedimento de deploy):
--   CREATE TABLE lead_manager.bkp_leads_origem_<ts> AS
--     SELECT id, origem, phone FROM lead_manager.leads;
-- ---------------------------------------------------------------------------
WITH primeiro_canal AS (
    SELECT regexp_replace(external_id, '[^0-9]', '', 'g') AS ident,
           (array_agg(channel ORDER BY created_at ASC))[1] AS canal
      FROM lead_manager.conversations
     GROUP BY 1
)
UPDATE lead_manager.leads l
   SET origem = COALESCE(
                  pc.canal,
                  CASE WHEN l.meta_leadgen_id IS NOT NULL THEN 'meta_lead_ads'
                       WHEN l.meta_psid       IS NOT NULL THEN 'facebook_messenger'
                       ELSE 'whatsapp' END)
  FROM primeiro_canal pc
 WHERE l.origem IS NULL
   AND pc.ident = regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g')
   AND regexp_replace(coalesce(l.phone, l.meta_psid, ''), '[^0-9]', '', 'g') <> '';

-- Leads sem nenhuma conversa casável (não atingidos pelo JOIN acima).
UPDATE lead_manager.leads
   SET origem = CASE WHEN meta_leadgen_id IS NOT NULL THEN 'meta_lead_ads'
                     WHEN meta_psid       IS NOT NULL THEN 'facebook_messenger'
                     ELSE 'whatsapp' END
 WHERE origem IS NULL;
