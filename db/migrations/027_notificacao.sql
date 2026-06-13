-- ============================================================
-- Bloco 4 — notificação push via WhatsApp (recepção). Config por tenant + anti-spam.
-- (notif_link_base é extra: o LM precisa do link /f/<slug> e não tem o slug.)
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 027_notificacao.sql
-- ============================================================

ALTER TABLE lead_manager.tenants
  ADD COLUMN IF NOT EXISTS notif_enabled        boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS notif_phones         text[],
  ADD COLUMN IF NOT EXISTS notif_min_confidence decimal(4,3) DEFAULT 0.85,
  ADD COLUMN IF NOT EXISTS notif_link_base      text;

ALTER TABLE lead_manager.leads
  ADD COLUMN IF NOT EXISTS notif_last_sent timestamptz;

-- Popula Valinhos.
UPDATE lead_manager.tenants
   SET notif_enabled = true,
       notif_phones = ARRAY['5519997078916'],
       notif_min_confidence = 0.85,
       notif_link_base = 'https://agenda.leovecchi.com/f/valinhos'
 WHERE id = 'ed731a58-62e5-45ad-acba-a5502ff39e92';
