-- ============================================================
-- 105_service_account_professor_person.sql — PROFESSOR CANÔNICO no contrato.
--
-- CONTEXTO: o dashboard (adr-whatsapp-scheduler, migration 058) já ADICIONOU estas colunas em
-- PRODUÇÃO e as enriquece a partir do Excel da Extranet (bi_raw.contracts → professor_nome) +
-- resolve o nome → person.id (professor_person_id). Como o adr-lead-manager tem o SEU próprio
-- conjunto de migrations (e o Postgres é COMPARTILHADO), esta migration declara as MESMAS colunas
-- no lado do LM para que src/cadastro/sync-professores.js (que agora garante o external_ref do
-- professor e fecha professor_person_id) tenha esquema consistente em DEV/itest e em PROD.
--
-- ADITIVA e IDEMPOTENTE: ADD COLUMN IF NOT EXISTS → no-op onde a 058 já rodou; cria onde ainda não.
-- NÃO mexe em RLS/posse (colunas em tabela existente herdam a política de service_account, 060).
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -f 105_service_account_professor_person.sql
-- ============================================================

ALTER TABLE lead_manager.service_account
  ADD COLUMN IF NOT EXISTS professor_person_id uuid,   -- professor CANÔNICO (→ lead_manager.person)
  ADD COLUMN IF NOT EXISTS professor_nome      text;   -- nome do Excel (fallback / auditoria / chave de resolução)

CREATE INDEX IF NOT EXISTS idx_sa_professor_person
  ON lead_manager.service_account (tenant_id, professor_person_id);

-- ROLLBACK (manual — só se a 058 do dashboard também for revertida; senão o dashboard ainda usa):
--   DROP INDEX IF EXISTS lead_manager.idx_sa_professor_person;
--   ALTER TABLE lead_manager.service_account
--     DROP COLUMN IF EXISTS professor_person_id,
--     DROP COLUMN IF EXISTS professor_nome;
