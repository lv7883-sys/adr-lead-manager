-- 130 — Lead criado pelo sync da Extranet nasce na DATA DO CADASTRO na Extranet.
--
-- PROBLEMA (auditoria 2026-09-18): o sync de leads da Extranet (migr 102) cria o lead de quem a
-- recepção cadastrou lá e nunca falou no WhatsApp. O created_at vinha do default now(). A 1ª
-- execução, em 11/08/2026, criou de uma vez 33 leads cadastrados na Extranet em mai (19), jun (10)
-- e jul (4). O funil do BI conta o lead no mês de created_at, então agosto ganhou 21 leads, 6 aulas
-- agendadas e 2 realizadas que eram de outros meses (os outros 12 já estavam fora do funil).
--
-- CORREÇÃO: created_at = data_cadastro da Extranet, só quando:
--   • o lead foi CRIADO pelo sync (origem = 'extranet' — first-touch imutável, migr 043), e
--   • o cadastro na Extranet é ANTERIOR ao created_at (nunca empurra para frente).
-- Com mais de uma linha no espelho para o mesmo lead, vale o cadastro mais antigo.
-- O código (sync-extranet-leads.matchOuCria) já cria assim daqui para frente.
--
-- Não mexe em lead de WhatsApp (o created_at dele é a 1ª mensagem que o Regente viu).
-- Idempotente: re-rodar não acha mais nada para mudar.

UPDATE lead_manager.leads l
   SET created_at = x.cadastro
  FROM (SELECT el.lead_id, min(el.data_cadastro) AS cadastro
          FROM lead_manager.extranet_lead el
         WHERE el.lead_id IS NOT NULL AND el.data_cadastro IS NOT NULL
         GROUP BY el.lead_id) x
 WHERE l.id = x.lead_id
   AND l.origem = 'extranet'
   AND x.cadastro < l.created_at;
