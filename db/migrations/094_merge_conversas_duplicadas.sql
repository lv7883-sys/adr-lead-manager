-- ============================================================
-- 094 — FUSÃO de conversas WhatsApp DUPLICADAS (mesmo contato em 2+ linhas na Caixa de Entrada).
--
-- CAUSA: o funil (src/engine.js) gravava external_id em E.164 "+55..." (telBR.toE164BR) enquanto
-- normalizeMessage (webhook) e ensureConversation (outbound-first, src/routes/inbox.js) usam "55..."
-- (dígitos, SEM "+"). A UNIQUE (tenant_id, channel, external_id) + ON CONFLICT casa EXATO, então
-- "+55DDD9NNNN" e "55DDD9NNNN" do MESMO telefone viram DUAS conversas. br_phone_key(external_id)
-- (migr 085) reduz ambas à MESMA chave canônica → é o critério de fusão aqui.
--
-- REGRA: só WhatsApp 1:1 (conversation_kind DIRECT/legado). EXCLUI grupos (@g.us), comentários
-- (COMMENT) e canais Meta (external_id = psid, não-telefônico). A canônica = a com MAIS mensagens
-- (histórico real); empate → a mais ANTIGA (created_at); empate → menor id. Reponta os filhos
-- (messages, pending_approvals, message_favorites) das duplicatas p/ a canônica, avança last_read_at
-- (GREATEST — monotônico, NÃO reinfla o badge de não-lidas) e apaga as duplicatas.
--
-- staff_outbound_samples (respostas fromMe / toque de renovação) e renovacao_touchpoint são casados
-- por DÍGITOS do telefone (regexp_replace(external_id,...)), não por conversation_id → nada a fazer:
-- como a canônica preserva os mesmos dígitos, a timeline continua exibindo essas saídas.
--
-- IDEMPOTENTE: após rodar, nenhum grupo tem count>1 → rerodar é no-op. Transacional (tudo ou nada).
-- Roda como postgres (bypass RLS → varre TODOS os tenants). Migrations manuais, sem runner:
--   docker exec -i exp44a3i0nnip54f4xc0is0i psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 \
--     -f db/migrations/094_merge_conversas_duplicadas.sql
--
-- PRÉVIA (não altera nada) — telefones afetados e quantas duplicatas cada um tem:
--   SELECT tenant_id, lead_manager.br_phone_key(external_id) AS pkey, count(*) AS linhas,
--          array_agg(external_id ORDER BY created_at) AS formatos
--     FROM lead_manager.conversations
--    WHERE channel='whatsapp' AND coalesce(conversation_kind,'DIRECT')='DIRECT'
--      AND external_id NOT LIKE '%@g.us' AND lead_manager.br_phone_key(external_id) <> ''
--    GROUP BY tenant_id, pkey HAVING count(*) > 1
--    ORDER BY linhas DESC;
--
-- SEM rollback automático: a fusão apaga linhas. Faça dump das tabelas conversations/messages/
-- pending_approvals/message_favorites antes, se quiser reversão.
-- ============================================================

-- Índice funcional p/ o FIND-OR-CREATE por br_phone_key (upsertConversation no funil roda esse
-- lookup a cada inbound; sem índice = seq scan). Também acelera a query de fusão abaixo.
-- Fora da transação (CREATE INDEX IF NOT EXISTS é idempotente).
CREATE INDEX IF NOT EXISTS idx_conversations_brphonekey
  ON lead_manager.conversations (tenant_id, lead_manager.br_phone_key(external_id))
  WHERE channel = 'whatsapp';

BEGIN;

-- Mapa duplicata -> canônica (materializado p/ reusar entre os UPDATEs e o DELETE).
CREATE TEMP TABLE _dup_map ON COMMIT DROP AS
WITH cand AS (
  SELECT c.id, c.tenant_id, c.created_at, c.last_read_at,
         lead_manager.br_phone_key(c.external_id) AS pkey,
         (SELECT count(*) FROM lead_manager.messages m WHERE m.conversation_id = c.id) AS msg_ct
    FROM lead_manager.conversations c
   WHERE c.channel = 'whatsapp'
     AND coalesce(c.conversation_kind, 'DIRECT') = 'DIRECT'   -- exclui GROUP / COMMENT
     AND c.external_id NOT LIKE '%@g.us'                      -- defensivo: nunca grupo
     AND lead_manager.br_phone_key(c.external_id) <> ''       -- precisa ter chave telefônica
),
grp AS (   -- só telefones com 2+ conversas no MESMO tenant
  SELECT tenant_id, pkey FROM cand
   GROUP BY tenant_id, pkey
  HAVING count(*) > 1
),
ranked AS (
  SELECT cand.*,
         row_number() OVER (
           PARTITION BY cand.tenant_id, cand.pkey
           ORDER BY cand.msg_ct DESC, cand.created_at ASC, cand.id ASC
         ) AS rn
    FROM cand
    JOIN grp USING (tenant_id, pkey)
),
keeps AS (
  SELECT tenant_id, pkey, id AS keep_id FROM ranked WHERE rn = 1
)
SELECT r.id AS dup_id, k.keep_id, r.tenant_id, r.last_read_at AS dup_last_read
  FROM ranked r
  JOIN keeps k USING (tenant_id, pkey)
 WHERE r.rn > 1;

-- 1) Reponta as MENSAGENS das duplicatas p/ a canônica.
--    (external_message_id é único por tenant e não muda → sem colisão na UNIQUE de messages.)
UPDATE lead_manager.messages m
   SET conversation_id = d.keep_id
  FROM _dup_map d
 WHERE m.conversation_id = d.dup_id;

-- 2) Reponta pending_approvals (rascunhos da IA) das duplicatas.
UPDATE lead_manager.pending_approvals p
   SET conversation_id = d.keep_id
  FROM _dup_map d
 WHERE p.conversation_id = d.dup_id;

-- 3) Reponta favoritos (message_favorites.conversation_id; message_id não muda).
UPDATE lead_manager.message_favorites f
   SET conversation_id = d.keep_id
  FROM _dup_map d
 WHERE f.conversation_id = d.dup_id;

-- 4) last_read_at da canônica = GREATEST do grupo (monotônico; NÃO reinfla o badge).
--    Como as duplicatas costumam ser vazias (sem inbound), na prática não muda o total.
UPDATE lead_manager.conversations cv
   SET last_read_at = GREATEST(COALESCE(cv.last_read_at, 'epoch'::timestamptz), sub.mx)
  FROM (
    SELECT keep_id, max(COALESCE(dup_last_read, 'epoch'::timestamptz)) AS mx
      FROM _dup_map GROUP BY keep_id
  ) sub
 WHERE cv.id = sub.keep_id
   AND (cv.last_read_at IS NULL OR cv.last_read_at < sub.mx);

-- 5) Sobe a canônica na lista (recebeu histórico repontado).
UPDATE lead_manager.conversations cv
   SET updated_at = now()
  FROM _dup_map d
 WHERE cv.id = d.keep_id;

-- 6) Apaga as duplicatas (filhos já repontados; nada relevante cascateia).
DELETE FROM lead_manager.conversations c
 USING _dup_map d
 WHERE c.id = d.dup_id;

COMMIT;

-- CONFERÊNCIA (rode depois; deve dar 0 grupos remanescentes):
--   SELECT count(*) AS grupos_com_duplicata FROM (
--     SELECT tenant_id, lead_manager.br_phone_key(external_id) AS pkey
--       FROM lead_manager.conversations
--      WHERE channel='whatsapp' AND coalesce(conversation_kind,'DIRECT')='DIRECT'
--        AND external_id NOT LIKE '%@g.us' AND lead_manager.br_phone_key(external_id) <> ''
--      GROUP BY tenant_id, pkey HAVING count(*) > 1) t;
--
-- BADGE não-lidas (deve permanecer igual/menor — nunca reinflar):
--   SELECT COALESCE(SUM(n),0)::int FROM (
--     SELECT (SELECT count(*) FROM lead_manager.messages m
--              WHERE m.conversation_id = cv.id AND m.role='USER'
--                AND (cv.last_read_at IS NULL OR m.received_at > cv.last_read_at)) AS n
--       FROM lead_manager.conversations cv
--      WHERE coalesce(cv.external_id,'') NOT LIKE '%@g.us') u;
