-- ============================================================
-- 087 — ADR-042/Meta: COMENTÁRIOS de posts (IG/FB) na Caixa de Entrada.
-- Comentário vira uma conversa com conversation_kind='COMMENT' (channel instagram_comment /
-- facebook_comment). Aqui só liberamos o novo valor no CHECK; a ingestão é no app
-- (engine.captureComment). ADITIVA — nenhuma conversa muda de tipo.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 087_conversation_kind_comment.sql
-- ============================================================

ALTER TABLE lead_manager.conversations DROP CONSTRAINT IF EXISTS conversations_conversation_kind_check;
ALTER TABLE lead_manager.conversations
  ADD CONSTRAINT conversations_conversation_kind_check
  CHECK (conversation_kind IN ('DIRECT', 'GROUP', 'COMMUNITY', 'COMMENT'));

-- ROLLBACK (manual): volta ao conjunto anterior (só se não houver linhas 'COMMENT').
--   ALTER TABLE lead_manager.conversations DROP CONSTRAINT IF EXISTS conversations_conversation_kind_check;
--   ALTER TABLE lead_manager.conversations ADD CONSTRAINT conversations_conversation_kind_check
--     CHECK (conversation_kind IN ('DIRECT','GROUP','COMMUNITY'));
