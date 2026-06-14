-- ============================================================
-- E6 — resposta outbound via Meta (Messenger / Instagram DM).
-- O envio usa o meta_psid (Page-Scoped ID) do lead como destinatário na
-- Graph API: POST /{page_id}/messages { recipient: { id: psid }, ... }.
--
-- meta_psid JÁ existe desde a migration 015 (015_meta_channels.sql). Esta
-- migration é IDEMPOTENTE e só garante a coluna em bases que pulem a 015 —
-- é no-op nas bases já migradas.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 030_meta_psid.sql
-- ============================================================

ALTER TABLE lead_manager.leads
  ADD COLUMN IF NOT EXISTS meta_psid text;

CREATE UNIQUE INDEX IF NOT EXISTS leads_meta_psid_uq
  ON lead_manager.leads (tenant_id, meta_psid) WHERE meta_psid IS NOT NULL;
