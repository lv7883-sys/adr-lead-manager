-- ============================================================
-- 113 — "Mensagem duplicada": funde as CONVERSAS FANTASMA de grupo.
--
-- SINTOMA (recepção, 09/09/2026): "às vezes ele mostra a mensagem duplicada. Eu respondo no grupo e
-- ele mostra como se eu tivesse mandado para a pessoa no privado."
--
-- CAUSA: existem 11 conversas DIRETAS cujo external_id é o ID DE UM GRUPO sem o sufixo @g.us
-- (ex.: '120363224711320694'), criadas em 12–17/jun/2026 — o grupo real existe em paralelo, com o
-- sufixo. Como TODO o casamento do produto é por DÍGITOS do external_id (não há FK conversa↔lead),
-- o grupo e a fantasma têm a MESMA identidade: a timeline da fantasma mostra a conversa inteira do
-- grupo (entradas e saídas), a lista exibe o nome do último participante que falou — parecendo um
-- privado com aquela pessoa — e responder ali manda para o grupo.
--
-- O código foi corrigido junto (mesmo commit): E.164 tem no máximo 15 dígitos, então id de 18 nunca
-- mais vira conversa direta (engine.upsertConversation e inbox.ensureConversation); a timeline
-- separa grupo de conversa direta; e a saída pelo Regente passa a gravar is_group.
--
-- ESTA MIGRAÇÃO cuida do que já está no banco: as mensagens da fantasma (jun/2026) NÃO existem no
-- grupo real (conferido: 0 sobreposição por external_message_id e por texto+horário; o grupo só tem
-- de jul/2026 em diante) — são o histórico de junho daquele grupo, importado no lugar errado. Então
-- MUDA A CONVERSA das mensagens em vez de apagar, e só depois remove a fantasma.
--
-- APLICAR:
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 113_funde_conversas_fantasma_de_grupo.sql
-- ============================================================

BEGIN;

CREATE TEMP TABLE fantasmas ON COMMIT DROP AS
SELECT f.id AS fantasma_id, g.id AS grupo_id, f.tenant_id, f.external_id
  FROM lead_manager.conversations f
  JOIN lead_manager.conversations g
    ON g.tenant_id = f.tenant_id
   AND g.external_id = f.external_id || '@g.us'
   AND g.conversation_kind = 'GROUP'
 WHERE f.conversation_kind <> 'GROUP'
   AND f.external_id ~ '^[0-9]{16,}$';   -- acima do teto do E.164 (15) = não é telefone

\echo '-- fantasmas encontradas:'
SELECT count(*) AS fantasmas, sum((SELECT count(*) FROM lead_manager.messages m
                                    WHERE m.conversation_id = f.fantasma_id)) AS msgs_a_mover
  FROM fantasmas f;

-- 1) Mensagens vão para o grupo real (o histórico de junho volta para a thread certa).
UPDATE lead_manager.messages m
   SET conversation_id = f.grupo_id
  FROM fantasmas f
 WHERE m.conversation_id = f.fantasma_id;

-- 2) Rascunhos da IA presos na fantasma: são de junho e de conversa de grupo (a IA não atende
--    grupo) — arquiva em vez de mover, para não ressuscitarem como "rascunho pronto".
UPDATE lead_manager.pending_approvals pa
   SET status = 'ARCHIVED', conversation_id = f.grupo_id
  FROM fantasmas f
 WHERE pa.conversation_id = f.fantasma_id;

UPDATE lead_manager.janis_estrategia_chat j
   SET conversation_id = f.grupo_id
  FROM fantasmas f
 WHERE j.conversation_id = f.fantasma_id;

-- 3) A fantasma some.
DELETE FROM lead_manager.conversations c
 USING fantasmas f
 WHERE c.id = f.fantasma_id;

-- 4) Saídas gravadas pelo Regente para um grupo (source='api', raw nulo) ficaram com is_group=false
--    — é o que fazia a resposta do grupo aparecer como privada. Marca pelo id do grupo.
UPDATE lead_manager.staff_outbound_samples s
   SET is_group = true
 WHERE s.is_group IS NOT TRUE
   AND EXISTS (SELECT 1 FROM lead_manager.conversations g
                WHERE g.tenant_id = s.tenant_id
                  AND g.conversation_kind = 'GROUP'
                  AND regexp_replace(g.external_id, '[^0-9]', '', 'g')
                      = regexp_replace(s.external_id, '[^0-9]', '', 'g'));

-- 5) A atividade do grupo agora inclui o histórico movido (a coluna da migr. 111 é mantida por
--    gatilho de INSERT; o UPDATE do passo 1 não passa por ele).
UPDATE lead_manager.conversations c
   SET last_activity_at = GREATEST(c.last_activity_at,
                                   (SELECT max(m.received_at) FROM lead_manager.messages m
                                     WHERE m.conversation_id = c.id AND m.role = 'USER'))
 WHERE c.conversation_kind = 'GROUP';

\echo '-- deve dar 0 (nenhuma conversa direta com id de grupo sobrando):'
SELECT count(*) AS fantasmas_restantes
  FROM lead_manager.conversations
 WHERE conversation_kind <> 'GROUP' AND external_id ~ '^[0-9]{16,}$';

COMMIT;

-- ROLLBACK: não há volta automática (as fantasmas são apagadas). Se precisar reverter, restaure do
-- backup: nada foi perdido além das linhas de conversations — mensagens e rascunhos só mudaram de
-- conversa, e o vínculo antigo estava errado.
