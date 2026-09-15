-- ============================================================
-- 116 — PARIDADE COM O WHATSAPP (etapa 3): todo tipo de conteúdo e a citação feita no celular.
--
--   conteudo              — dados estruturados da mensagem p/ a tela desenhar como o WhatsApp: localização,
--                           contato, enquete (com votos), lista, botões e respostas, evento, convite de grupo,
--                           prévia de link, mensagem de sistema/ligação; e o contexto (menções, encaminhada,
--                           temporária, visualização única). Gerado por src/waConteudo.js.
--   reply_to_external_id  — id do WhatsApp da mensagem citada. A citação feita no celular/Web só traz esse id,
--                           e pode apontar para mensagem do cliente OU da escola — a FK reply_to_message_id
--                           (só messages) não servia. A timeline resolve pelos dois lados.
--
-- APLICAR:
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 116_conteudo_e_citacao_whatsapp.sql
-- ============================================================

BEGIN;

ALTER TABLE lead_manager.messages
  ADD COLUMN IF NOT EXISTS conteudo jsonb,
  ADD COLUMN IF NOT EXISTS reply_to_external_id text;

ALTER TABLE lead_manager.staff_outbound_samples
  ADD COLUMN IF NOT EXISTS conteudo jsonb,
  ADD COLUMN IF NOT EXISTS reply_to_external_id text;

-- o papel da aplicação precisa ler e gravar as colunas novas (staff_outbound_samples tem grant por coluna)
GRANT SELECT (conteudo, reply_to_external_id), INSERT (conteudo, reply_to_external_id), UPDATE (conteudo, reply_to_external_id)
  ON lead_manager.staff_outbound_samples TO lead_manager_user;

COMMIT;

-- ROLLBACK (manual):
--   ALTER TABLE lead_manager.messages DROP COLUMN IF EXISTS conteudo, DROP COLUMN IF EXISTS reply_to_external_id;
--   ALTER TABLE lead_manager.staff_outbound_samples DROP COLUMN IF EXISTS conteudo, DROP COLUMN IF EXISTS reply_to_external_id;
