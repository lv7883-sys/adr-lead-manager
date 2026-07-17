-- ============================================================
-- Fatia 1 WhatsApp-like — checks de status (✓ enviado / ✓✓ entregue / ✓✓ lido)
-- nas mensagens que NÓS enviamos. ADITIVA e não-destrutiva.
--
-- POR QUE staff_outbound_samples (e NÃO messages):
--   - As saídas que a timeline renderiza vêm de staff_outbound_samples ('recepcao')
--     e pending_approvals ('ia'); a coluna messages.direction='outbound' NÃO entra
--     na timeline e tem external_message_id = NULL em 100% das linhas (689/689) →
--     não há id casável ali.
--   - staff_outbound_samples tem external_message_id (= key.id da Evolution) em 100%
--     das linhas, com UNIQUE (tenant_id, external_message_id) — é a âncora de
--     correlação com o MESSAGES_UPDATE de status. Reusamos esse id (sem coluna nova).
--
-- Monotônico na aplicação (nunca regride: read>delivered>sent). CHECK só restringe o
-- vocabulário; NULL = ainda sem ack (mensagem recém-enviada / sem update recebido).
--
-- Migrations manuais, sem runner (NUNCA db push):
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 062_ack_status.sql
-- ============================================================

ALTER TABLE lead_manager.staff_outbound_samples
  ADD COLUMN IF NOT EXISTS ack_status text
    CHECK (ack_status IS NULL OR ack_status IN ('sent', 'delivered', 'read'));

-- ROLLBACK (manual):
--   ALTER TABLE lead_manager.staff_outbound_samples DROP COLUMN IF EXISTS ack_status;
