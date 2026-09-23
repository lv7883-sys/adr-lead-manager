-- ============================================================================
-- 177 — o aprendizado precisa ENXERGAR o disparo de campanha para poder IGNORÁ-LO.
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 177_aprendizado_le_campanha.sql
--   (depende da 176)
--
-- POR QUÊ
--   O relatório de aprendizado (src/aprendizado.js) compara a sugestão da IA com a PRIMEIRA saída
--   que foi para aquele contato depois. Um convite do Rock Hour (ou NPS, ou renovação) sai pela
--   MESMA porta e com o MESMO source='api' da recepcionista respondendo pelo Regente — não dá para
--   separar por source. Se um disparo cair na janela, seria comparado com a sugestão e contado como
--   "escreveu do zero": a IA levaria a culpa por uma mensagem automática.
--
--   Dá para separar pelo ID da mensagem: todo disparo registra `wa_message_id` em app.campanha_alvo.
--   Só que o usuário do Lead Manager não tinha leitura nessa tabela, e o relatório morria com
--   "permission denied for table campanha_alvo" (descoberto no deploy de 23/09, ao rodar o
--   relatório pela primeira vez — a GRAVAÇÃO nunca foi afetada, só a leitura do relatório).
--
-- O QUE ESTE GRANT É, E O QUE NÃO É
--   É SELECT, em UMA tabela, para EXCLUIR linhas — o Lead Manager não escreve nem lê conteúdo de
--   campanha para usar; ele só pergunta "esta mensagem foi um disparo?". Precedente na casa: o LM
--   já lê resources.resource_source_binding, de outro schema, pelo mesmo tipo de motivo (saber a
--   configuração de uma fonte que não é dele).
--   NÃO é dependência de formato: se a coluna sumir, o relatório perde a exclusão e volta a
--   subestimar a IA — nunca a superestimar. O viés, quando falha, cai para o lado seguro.
-- ============================================================================

BEGIN;

GRANT USAGE ON SCHEMA app TO lead_manager_user;
GRANT SELECT (id, wa_message_id) ON app.campanha_alvo TO lead_manager_user;

COMMENT ON COLUMN app.campanha_alvo.wa_message_id IS
  'Id da mensagem no WhatsApp. Lido pelo Lead Manager (src/aprendizado.js) para EXCLUIR disparo de campanha da comparação sugestão-da-IA × resposta-enviada (migr. 177).';

COMMIT;
