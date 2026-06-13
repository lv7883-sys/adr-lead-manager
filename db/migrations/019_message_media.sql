-- ============================================================
-- ADR-016 P0 — mídia recebida (áudio/imagem/documento/vídeo) no histórico.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 019_message_media.sql
-- ============================================================

ALTER TABLE lead_manager.messages
  ADD COLUMN IF NOT EXISTS media_url           text,
  ADD COLUMN IF NOT EXISTS media_type          text,   -- audio | image | document | video
  ADD COLUMN IF NOT EXISTS media_filename      text,   -- nome original (documentos)
  ADD COLUMN IF NOT EXISTS media_transcription text;   -- transcrição (áudio)
