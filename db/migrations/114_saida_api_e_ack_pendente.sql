-- ============================================================
-- 114 — PARIDADE COM O WHATSAPP (etapa 1): todo envio do Regente aparece na hora, com os tiques.
--
-- PROBLEMA (auditoria 15/09/2026): os avisos que o dashboard envia pela API (agenda diária/semanal,
-- Rock Hour, NPS, boletim, campanhas, alertas) só apareciam na Caixa de Entrada na próxima busca de
-- histórico — até ~6 h depois. O evento SEND_MESSAGE estava desligado na instância. Ligado agora, o
-- webhook grava o envio como saída no ato (código). Esta migração cuida de duas pontas:
--
--   1) TIQUE QUE CHEGA ANTES DA MENSAGEM. A confirmação de entregue/lido (messages.update) pode ser
--      processada antes da linha da saída existir — e o UPDATE não achava nada e perdia o tique.
--      Agora ela espera em wa_ack_pendente e um gatilho BEFORE INSERT aplica quando a saída entra,
--      por QUALQUER caminho (webhook, registro do próprio Regente, busca de histórico).
--
--   2) O PASSADO. Os avisos já importados sem tiques ganham o status que o dashboard registrou
--      (app.envio_log / app.envio_pendente / app.campanha_alvo), e os que entraram SEM TEXTO recebem
--      o texto que o dashboard enviou.
--
-- APLICAR:
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 114_saida_api_e_ack_pendente.sql
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS lead_manager.wa_ack_pendente (
  tenant_id            uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  external_message_id  text NOT NULL,
  ack_status           text NOT NULL CHECK (ack_status IN ('sent','delivered','read')),
  recebido_em          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, external_message_id)
);
ALTER TABLE lead_manager.wa_ack_pendente OWNER TO lead_manager_user;
ALTER TABLE lead_manager.wa_ack_pendente ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.wa_ack_pendente FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON lead_manager.wa_ack_pendente;
CREATE POLICY tenant_isolation ON lead_manager.wa_ack_pendente
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Aplica o tique que chegou antes. Monotônico (read > delivered > sent): nunca rebaixa o que a linha já traz.
CREATE OR REPLACE FUNCTION lead_manager.tg_staff_aplica_ack_pendente() RETURNS trigger AS $$
DECLARE
  pend text;
BEGIN
  IF NEW.external_message_id IS NULL THEN
    RETURN NEW;
  END IF;
  DELETE FROM lead_manager.wa_ack_pendente
   WHERE tenant_id = NEW.tenant_id AND external_message_id = NEW.external_message_id
  RETURNING ack_status INTO pend;
  IF pend IS NOT NULL AND
     (CASE pend WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 0 END)
     > (CASE NEW.ack_status WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 0 END) THEN
    NEW.ack_status := pend;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_staff_aplica_ack_pendente ON lead_manager.staff_outbound_samples;
CREATE TRIGGER trg_staff_aplica_ack_pendente
  BEFORE INSERT ON lead_manager.staff_outbound_samples
  FOR EACH ROW EXECUTE FUNCTION lead_manager.tg_staff_aplica_ack_pendente();

-- ---------- PASSADO: tiques dos avisos já importados ----------
WITH d AS (
  SELECT payload->>'wa_message_id' AS wa, delivery_status AS st FROM app.envio_log WHERE payload ? 'wa_message_id'
  UNION ALL
  SELECT metadata->>'wa_message_id', delivery_status FROM app.envio_pendente WHERE metadata ? 'wa_message_id'
  UNION ALL
  SELECT wa_message_id, delivery_status FROM app.campanha_alvo WHERE wa_message_id IS NOT NULL
), melhor AS (
  SELECT wa, max(CASE st WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 0 END) AS r
    FROM d WHERE wa IS NOT NULL GROUP BY wa
)
UPDATE lead_manager.staff_outbound_samples s
   SET ack_status = CASE m.r WHEN 1 THEN 'sent' WHEN 2 THEN 'delivered' WHEN 3 THEN 'read' END
  FROM melhor m
 WHERE s.external_message_id = m.wa
   AND m.r > 0
   AND (CASE s.ack_status WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 0 END) < m.r;

-- ---------- PASSADO: avisos importados sem texto recebem o texto que foi enviado ----------
-- Prioridade: o texto por destinatário da campanha, depois o registro do envio, por último a pendência.
WITH t AS (
  SELECT wa_message_id AS wa, texto, 1 AS prio FROM app.campanha_alvo WHERE wa_message_id IS NOT NULL
  UNION ALL
  SELECT payload->>'wa_message_id', payload->>'texto', 2 FROM app.envio_log WHERE payload ? 'wa_message_id'
  UNION ALL
  SELECT metadata->>'wa_message_id', coalesce(texto_editado, texto_padrao), 3 FROM app.envio_pendente WHERE metadata ? 'wa_message_id'
), escolhido AS (
  SELECT DISTINCT ON (wa) wa, texto FROM t
   WHERE wa IS NOT NULL AND coalesce(trim(texto), '') <> ''
   ORDER BY wa, prio
)
UPDATE lead_manager.staff_outbound_samples s
   SET body = e.texto
  FROM escolhido e
 WHERE s.external_message_id = e.wa
   AND coalesce(trim(s.body), '') = '';

COMMIT;

-- ROLLBACK (manual):
--   DROP TRIGGER IF EXISTS trg_staff_aplica_ack_pendente ON lead_manager.staff_outbound_samples;
--   DROP FUNCTION IF EXISTS lead_manager.tg_staff_aplica_ack_pendente();
--   DROP TABLE IF EXISTS lead_manager.wa_ack_pendente;
--   (os tiques e textos preenchidos no passado ficam — são o que de fato foi enviado)
