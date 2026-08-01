-- ============================================================
-- 084 — ADR-006+: resposta automática FORA DO HORÁRIO (a "Janis"). Aditiva.
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 084_autoreply_fora_horario.sql
-- ============================================================

-- Nome com que a IA assina as respostas automáticas (nunca o nome de uma recepcionista real).
-- Por tenant. Ex.: "Janis Joplin". NULL => cai num rótulo genérico no código.
ALTER TABLE lead_manager.automacao_config
  ADD COLUMN IF NOT EXISTS nome_ia text;

-- Cooldown "1x por janela fechada": marca quando a Janis respondeu automaticamente a conversa.
-- Se auto_reply_at >= início da janela fechada atual, NÃO responde de novo (anti-spam).
ALTER TABLE lead_manager.conversations
  ADD COLUMN IF NOT EXISTS auto_reply_at timestamptz;

-- ROLLBACK (manual):
--   ALTER TABLE lead_manager.automacao_config DROP COLUMN IF EXISTS nome_ia;
--   ALTER TABLE lead_manager.conversations   DROP COLUMN IF EXISTS auto_reply_at;
