-- ============================================================
-- 110 — CONSULTORIA DA JANIS (chat de estratégia INTERNO da recepção).
--
-- Quadro vermelho da Caixa de Entrada: a recepção conversa com a Janis (NÃO com o cliente) pra
-- pedir estratégia de abordagem daquela conversa. Suporta texto + mídia (áudio/foto/vídeo). A Janis
-- lê o contexto REAL da conversa com o cliente e responde com estratégia de vendas, sem alucinar.
--
-- 1 linha por MENSAGEM do chat de estratégia, escopada por conversa. role: 'user' (recepção) ou
-- 'assistant' (Janis). Mídia guardada em disco (MEDIA_ROOT), servida pelo mesmo proxy /media.
--
-- APLICAR:
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 110_janis_estrategia_chat.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_manager.janis_estrategia_chat (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  conversation_id     uuid NOT NULL REFERENCES lead_manager.conversations(id) ON DELETE CASCADE,
  role                text NOT NULL CHECK (role IN ('user','assistant')),  -- user = recepção; assistant = Janis
  body                text,                 -- texto da mensagem (ou transcrição/legenda)
  media_url           text,                 -- /media/<tenant>/<uuid>.<ext> (foto/vídeo/áudio da recepção)
  media_type          text,                 -- image | video | audio | document
  media_filename      text,
  media_transcription text,                 -- transcrição do áudio (quando houver)
  autor               text,                 -- nome/e-mail de quem escreveu (só p/ 'user'); NULL p/ Janis
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_janis_estrategia_conv
  ON lead_manager.janis_estrategia_chat (tenant_id, conversation_id, created_at);

ALTER TABLE lead_manager.janis_estrategia_chat OWNER TO lead_manager_user;
ALTER TABLE lead_manager.janis_estrategia_chat ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.janis_estrategia_chat FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.janis_estrategia_chat;
CREATE POLICY tenant_isolation ON lead_manager.janis_estrategia_chat
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ROLLBACK (manual):
--   DROP TABLE IF EXISTS lead_manager.janis_estrategia_chat;
