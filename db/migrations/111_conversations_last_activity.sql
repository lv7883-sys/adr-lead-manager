-- ============================================================
-- 111 — PERF da Caixa de Entrada: materializa a ÚLTIMA ATIVIDADE na conversa.
--
-- PROBLEMA (medido 09/09/2026, EXPLAIN ANALYZE sob ROLE+set_config): a listagem do inbox levava
-- ~415ms porque, para devolver as 50 conversas do topo, ela calculava a última atividade e todo o
-- enriquecimento (lead, renovação, cadastro, contato interno) das 2.012 conversas do tenant, e SÓ
-- ENTÃO ordenava e cortava em 50. Como essa query roda no load, na busca E no auto-refresh, o banco
-- ficava ocupado com ela quase o tempo todo — daí a sensação de lentidão no uso.
--
-- SOLUÇÃO: guardar a última atividade direto em conversations (indexada), para a query pegar as 50
-- primeiras JÁ ORDENADAS e enriquecer só essas 50.
--
-- SEMÂNTICA (idêntica à do último_ato da query): última atividade = a MAIS RECENTE entre
--   (a) última mensagem de ENTRADA do cliente (messages role='USER') daquela conversa, e
--   (b) última saída da RECEPÇÃO (staff_outbound_samples, não-grupo) casada pelos DÍGITOS do telefone
--       — mesmo casamento do ult_recep (regexp_replace, NÃO br_phone_key);
-- se não houver nenhuma das duas, cai em conversations.updated_at.
--
-- MANUTENÇÃO POR TRIGGER (e não no app) de propósito: mensagens entram por vários caminhos (webhook,
-- import de histórico, backfill de reconexão, sync). O trigger cobre todos sem depender de lembrar.
--
-- APLICAR:
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 111_conversations_last_activity.sql
-- ============================================================

ALTER TABLE lead_manager.conversations
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;

-- Ordenação da lista (o que a query passa a usar p/ cortar cedo).
CREATE INDEX IF NOT EXISTS idx_conversations_tenant_last_act
  ON lead_manager.conversations (tenant_id, last_activity_at DESC, id DESC);

-- Lookup do trigger de saída (casa a conversa pelos dígitos do telefone).
CREATE INDEX IF NOT EXISTS idx_conversations_tenant_ident
  ON lead_manager.conversations (tenant_id, (regexp_replace(external_id, '[^0-9]', '', 'g')));

-- ---------- BACKFILL (mesma régua da query) ----------
WITH ult_lead AS (
  SELECT conversation_id, max(received_at) AS ts
    FROM lead_manager.messages
   WHERE role = 'USER'
   GROUP BY conversation_id
),
ult_recep AS (
  SELECT tenant_id, regexp_replace(external_id, '[^0-9]', '', 'g') AS ident, max(received_at) AS ts
    FROM lead_manager.staff_outbound_samples
   WHERE is_group IS NOT TRUE
     AND regexp_replace(external_id, '[^0-9]', '', 'g') <> ''
   GROUP BY 1, 2
)
UPDATE lead_manager.conversations c
   SET last_activity_at = x.la
  FROM (
    SELECT cv.id,
           COALESCE(GREATEST(ul.ts, ur.ts), cv.updated_at) AS la
      FROM lead_manager.conversations cv
      LEFT JOIN ult_lead  ul ON ul.conversation_id = cv.id
      LEFT JOIN ult_recep ur ON ur.tenant_id = cv.tenant_id
                            AND ur.ident = regexp_replace(cv.external_id, '[^0-9]', '', 'g')
                            AND regexp_replace(cv.external_id, '[^0-9]', '', 'g') <> ''
  ) x
 WHERE c.id = x.id
   AND c.last_activity_at IS DISTINCT FROM x.la;

-- ---------- TRIGGERS (mantêm a coluna em qualquer caminho de inserção) ----------
-- Entrada do cliente: só role='USER' conta como atividade (igual ao ult_lead).
CREATE OR REPLACE FUNCTION lead_manager.tg_conv_last_activity_msg() RETURNS trigger AS $$
BEGIN
  IF NEW.role = 'USER' AND NEW.conversation_id IS NOT NULL AND NEW.received_at IS NOT NULL THEN
    UPDATE lead_manager.conversations
       SET last_activity_at = NEW.received_at
     WHERE id = NEW.conversation_id
       AND (last_activity_at IS NULL OR last_activity_at < NEW.received_at);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_conv_last_activity_msg ON lead_manager.messages;
CREATE TRIGGER trg_conv_last_activity_msg
  AFTER INSERT ON lead_manager.messages
  FOR EACH ROW EXECUTE FUNCTION lead_manager.tg_conv_last_activity_msg();

-- Saída da recepção (não-grupo): casa a conversa pelos DÍGITOS do telefone (igual ao ult_recep).
CREATE OR REPLACE FUNCTION lead_manager.tg_conv_last_activity_staff() RETURNS trigger AS $$
BEGIN
  IF NEW.is_group IS NOT TRUE AND NEW.received_at IS NOT NULL
     AND regexp_replace(COALESCE(NEW.external_id, ''), '[^0-9]', '', 'g') <> '' THEN
    UPDATE lead_manager.conversations c
       SET last_activity_at = NEW.received_at
     WHERE c.tenant_id = NEW.tenant_id
       AND regexp_replace(c.external_id, '[^0-9]', '', 'g')
           = regexp_replace(NEW.external_id, '[^0-9]', '', 'g')
       AND (c.last_activity_at IS NULL OR c.last_activity_at < NEW.received_at);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_conv_last_activity_staff ON lead_manager.staff_outbound_samples;
CREATE TRIGGER trg_conv_last_activity_staff
  AFTER INSERT ON lead_manager.staff_outbound_samples
  FOR EACH ROW EXECUTE FUNCTION lead_manager.tg_conv_last_activity_staff();

-- ROLLBACK (manual):
--   DROP TRIGGER IF EXISTS trg_conv_last_activity_msg ON lead_manager.messages;
--   DROP TRIGGER IF EXISTS trg_conv_last_activity_staff ON lead_manager.staff_outbound_samples;
--   DROP FUNCTION IF EXISTS lead_manager.tg_conv_last_activity_msg();
--   DROP FUNCTION IF EXISTS lead_manager.tg_conv_last_activity_staff();
--   DROP INDEX IF EXISTS lead_manager.idx_conversations_tenant_last_act;
--   DROP INDEX IF EXISTS lead_manager.idx_conversations_tenant_ident;
--   ALTER TABLE lead_manager.conversations DROP COLUMN IF EXISTS last_activity_at;
--   (a query volta ao caminho antigo sozinha se a coluna sumir? NÃO — reverta o código junto.)
