-- ============================================================
-- ADR-016 P1 — mídia/mensagens enviadas pela recepção (via dashboard) ficam em
-- staff_outbound_samples (mesmo lugar das respostas reais; o eco fromMe do webhook
-- deduplica pela unique (tenant_id, external_message_id)).
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 020_staff_outbound_media.sql
-- ============================================================

ALTER TABLE lead_manager.staff_outbound_samples
  ADD COLUMN IF NOT EXISTS media_url      text,
  ADD COLUMN IF NOT EXISTS media_type     text,   -- audio | image | document | video
  ADD COLUMN IF NOT EXISTS media_filename text;
