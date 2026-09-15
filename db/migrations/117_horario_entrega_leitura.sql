-- ============================================================
-- 117 — PARIDADE COM O WHATSAPP (etapa 5): "Dados da mensagem" — quando a mensagem foi ENTREGUE e LIDA.
--
-- No WhatsApp, em qualquer mensagem enviada, "Dados da mensagem" mostra o horário de entrega e de leitura.
-- O Regente só guardava o estágio do tique (ack_status), sem hora. Agora o webhook grava a hora em que o
-- tique chegou (o evento é em tempo real) — e o tique que chega antes da mensagem leva a hora junto.
--
-- APLICAR:
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 117_horario_entrega_leitura.sql
-- ============================================================
BEGIN;

ALTER TABLE lead_manager.staff_outbound_samples
  ADD COLUMN IF NOT EXISTS entregue_em timestamptz,
  ADD COLUMN IF NOT EXISTS lida_em     timestamptz;
-- staff_outbound_samples tem grant por coluna (ver 116)
GRANT SELECT (entregue_em, lida_em), INSERT (entregue_em, lida_em), UPDATE (entregue_em, lida_em)
  ON lead_manager.staff_outbound_samples TO lead_manager_user;

ALTER TABLE lead_manager.wa_ack_pendente
  ADD COLUMN IF NOT EXISTS entregue_em timestamptz,
  ADD COLUMN IF NOT EXISTS lida_em     timestamptz;

CREATE OR REPLACE FUNCTION lead_manager.tg_staff_aplica_ack_pendente() RETURNS trigger AS $$
DECLARE
  pend text;
  p_ent timestamptz;
  p_lida timestamptz;
BEGIN
  IF NEW.external_message_id IS NULL THEN
    RETURN NEW;
  END IF;
  DELETE FROM lead_manager.wa_ack_pendente
   WHERE tenant_id = NEW.tenant_id AND external_message_id = NEW.external_message_id
  RETURNING ack_status, entregue_em, lida_em INTO pend, p_ent, p_lida;
  IF pend IS NOT NULL AND
     (CASE pend WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 0 END)
     > (CASE NEW.ack_status WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 0 END) THEN
    NEW.ack_status := pend;
  END IF;
  NEW.entregue_em := COALESCE(NEW.entregue_em, p_ent);
  NEW.lida_em := COALESCE(NEW.lida_em, p_lida);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;

-- ROLLBACK:
--   ALTER TABLE lead_manager.staff_outbound_samples DROP COLUMN IF EXISTS entregue_em, DROP COLUMN IF EXISTS lida_em;
--   ALTER TABLE lead_manager.wa_ack_pendente DROP COLUMN IF EXISTS entregue_em, DROP COLUMN IF EXISTS lida_em;
