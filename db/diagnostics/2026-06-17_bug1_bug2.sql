-- ============================================================================
-- Diagnóstico (SOMENTE LEITURA) — 2026-06-17
-- BUG 1: lead já respondido/agendado segue como "esperando resposta há Xh"
-- BUG 2: lead do WhatsApp não aparece no Lead Manager (+55 61 9960-1212)
--
-- Rodar como postgres (bypassa RLS):
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 2026-06-17_bug1_bug2.sql
-- Se rodar como lead_manager_user, descomente o SET abaixo.
-- NENHUM destes comandos altera dados (apenas SELECT).
-- ============================================================================

-- SET app.current_tenant = 'ed731a58-62e5-45ad-acba-a5502ff39e92';  -- valinhos
\set tenant '''ed731a58-62e5-45ad-acba-a5502ff39e92'''

-- ----------------------------------------------------------------------------
-- BUG 1 — Guilherme Inui: o relógio "esperando" é last_in (msg do lead) vs
-- last_out (staff_outbound_samples). Queremos saber: existe last_out? last_in
-- é mais recente que last_out? (cenário B: msg de cortesia reabriu o bucket)
-- ou last_out é NULL (cenário A: resposta da recepção não foi capturada).
-- ----------------------------------------------------------------------------
SELECT 'BUG1: lead' AS bloco;
SELECT id, name, phone, status, desfecho, intent, created_at, updated_at
  FROM lead_manager.leads
 WHERE tenant_id = :tenant
   AND name ILIKE '%inui%';

SELECT 'BUG1: last_in (msgs do lead) vs last_out (staff)' AS bloco;
WITH l AS (
  SELECT id, regexp_replace(coalesce(phone, meta_psid, ''), '[^0-9]', '', 'g') AS ident, phone
    FROM lead_manager.leads
   WHERE tenant_id = :tenant AND name ILIKE '%inui%'
)
SELECT l.id, l.phone,
       (SELECT max(m.received_at) FROM lead_manager.messages m
          JOIN lead_manager.conversations cv ON cv.id = m.conversation_id
         WHERE cv.tenant_id = :tenant AND m.role = 'USER'
           AND regexp_replace(cv.external_id,'[^0-9]','','g') = l.ident) AS last_in_normalizado,
       (SELECT max(m.received_at) FROM lead_manager.messages m
          JOIN lead_manager.conversations cv ON cv.id = m.conversation_id
         WHERE cv.external_id = l.phone AND m.role = 'USER') AS last_in_exato_eq_phone,
       (SELECT max(s.received_at) FROM lead_manager.staff_outbound_samples s
         WHERE s.tenant_id = :tenant
           AND regexp_replace(s.external_id,'[^0-9]','','g') = l.ident) AS last_out_staff,
       (SELECT count(*) FROM lead_manager.staff_outbound_samples s
         WHERE s.tenant_id = :tenant
           AND regexp_replace(s.external_id,'[^0-9]','','g') = l.ident) AS n_staff_out,
       (SELECT count(*) FROM lead_manager.pending_approvals pa
         WHERE pa.lead_id = l.id AND pa.status IN ('APPROVED','EDITED')) AS n_aprovados
  FROM l;

-- Linha do tempo completa (lead + staff) das últimas 20 trocas — confirma se a
-- última mensagem foi do lead (cortesia) e se houve resposta da recepção.
SELECT 'BUG1: timeline' AS bloco;
WITH l AS (
  SELECT regexp_replace(coalesce(phone, meta_psid, ''), '[^0-9]', '', 'g') AS ident
    FROM lead_manager.leads WHERE tenant_id = :tenant AND name ILIKE '%inui%'
)
SELECT received_at, origem, left(body, 80) AS trecho FROM (
  SELECT m.received_at, 'LEAD' AS origem, m.body
    FROM lead_manager.messages m
    JOIN lead_manager.conversations cv ON cv.id = m.conversation_id, l
   WHERE cv.tenant_id = :tenant AND m.role = 'USER'
     AND regexp_replace(cv.external_id,'[^0-9]','','g') = l.ident
  UNION ALL
  SELECT s.received_at, 'STAFF', s.body
    FROM lead_manager.staff_outbound_samples s, l
   WHERE s.tenant_id = :tenant
     AND regexp_replace(s.external_id,'[^0-9]','','g') = l.ident
) t ORDER BY received_at DESC LIMIT 20;

-- ----------------------------------------------------------------------------
-- BUG 2 — +55 61 9960-1212. Procura o número em TODAS as formas (com/sem o 9º
-- dígito) por sufixo dos últimos 8 dígitos = '99601212', em todas as tabelas.
-- Diz em que etapa exata caiu: lead criado? status? msg sem lead? descartado?
-- ----------------------------------------------------------------------------
\set suf '''%99601212'''

SELECT 'BUG2: leads que batem o número (qualquer forma)' AS bloco;
SELECT id, name, phone, meta_psid, status, review_queue, review_result, desfecho,
       classification_confidence, classification_reasoning, created_at
  FROM lead_manager.leads
 WHERE tenant_id = :tenant
   AND regexp_replace(coalesce(phone, meta_psid, ''), '[^0-9]', '', 'g') LIKE :suf;

SELECT 'BUG2: conversas + msgs (inclui discarded e classificacao)' AS bloco;
SELECT cv.id AS conv_id, cv.external_id, cv.channel, cv.created_at AS conv_em,
       m.id AS msg_id, m.role, m.received_at, m.discarded, m.discard_reason,
       left(coalesce(m.media_transcription, m.body), 80) AS trecho
  FROM lead_manager.conversations cv
  JOIN lead_manager.messages m ON m.conversation_id = cv.id
 WHERE cv.tenant_id = :tenant
   AND regexp_replace(cv.external_id, '[^0-9]', '', 'g') LIKE :suf
 ORDER BY m.received_at;

SELECT 'BUG2: staff_outbound (a recepcao respondeu por fora?)' AS bloco;
SELECT id, external_id, source, received_at, left(body, 80) AS trecho
  FROM lead_manager.staff_outbound_samples
 WHERE tenant_id = :tenant
   AND regexp_replace(external_id, '[^0-9]', '', 'g') LIKE :suf
 ORDER BY received_at;

SELECT 'BUG2: internal_contacts (descartado como interno?)' AS bloco;
SELECT id, phone, name, type, created_at
  FROM lead_manager.internal_contacts
 WHERE tenant_id = :tenant
   AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE :suf;

-- Duplicidade por 9º dígito: o mesmo último-8 aparece em DUAS formas distintas?
SELECT 'BUG2: formas distintas do mesmo numero (split 9o digito)' AS bloco;
SELECT DISTINCT regexp_replace(coalesce(phone, meta_psid,''),'[^0-9]','','g') AS forma, 'lead' AS origem
  FROM lead_manager.leads
 WHERE tenant_id = :tenant AND regexp_replace(coalesce(phone, meta_psid,''),'[^0-9]','','g') LIKE :suf
UNION
SELECT DISTINCT regexp_replace(external_id,'[^0-9]','','g'), 'conversation'
  FROM lead_manager.conversations
 WHERE tenant_id = :tenant AND regexp_replace(external_id,'[^0-9]','','g') LIKE :suf
UNION
SELECT DISTINCT regexp_replace(external_id,'[^0-9]','','g'), 'staff_outbound'
  FROM lead_manager.staff_outbound_samples
 WHERE tenant_id = :tenant AND regexp_replace(external_id,'[^0-9]','','g') LIKE :suf;
