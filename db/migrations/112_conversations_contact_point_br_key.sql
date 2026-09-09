-- ============================================================
-- 112 — PERF das abas da Caixa de Entrada: materializa a CHAVE DE TELEFONE (br_phone_key).
--
-- PROBLEMA (medido 09/09/2026, EXPLAIN ANALYZE sob ROLE+set_config): br_phone_key é uma função SQL
-- (migr. 085) — barata por chamada (~35µs), cara no volume: a listagem do inbox a chamava para as
-- 2.014 conversas do tenant (65ms por passada, e o pré-filtro da aba Renovações precisa de 1) e para
-- as 624 linhas de contact_point em CADA um dos CTEs `renov` e `pess` (~33ms cada). Só de função,
-- ~130ms de uma listagem de ~320ms.
--
-- SOLUÇÃO: guardar o resultado numa coluna GERADA. br_phone_key é IMMUTABLE (provolatile='i'), então
-- o próprio Postgres mantém a coluna — não há gatilho nem código de app para lembrar de atualizar.
--
-- ⚠ ARMADILHA A CONHECER: coluna GENERATED congela a função no momento da definição. Se um dia
--   br_phone_key mudar de régua (CREATE OR REPLACE), as linhas JÁ GRAVADAS não se recalculam sozinhas
--   e passam a divergir silenciosamente. Se isso acontecer, force a recomputação:
--     ALTER TABLE lead_manager.conversations ALTER COLUMN br_key DROP EXPRESSION;  -- vira coluna comum
--   e refaça esta migração (DROP COLUMN + ADD COLUMN GENERATED). Mesmo para contact_point.
--
-- APLICAR:
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 \
--     -f 112_conversations_contact_point_br_key.sql
-- ============================================================

-- Conversa: chave canônica do telefone do contato (a mesma que casa contrato/cadastro/toque).
ALTER TABLE lead_manager.conversations
  ADD COLUMN IF NOT EXISTS br_key text
  GENERATED ALWAYS AS (lead_manager.br_phone_key(external_id)) STORED;

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_brkey
  ON lead_manager.conversations (tenant_id, br_key);

-- Contato do cadastro: mesma chave sobre o telefone cru (usada por renov e pess).
ALTER TABLE lead_manager.contact_point
  ADD COLUMN IF NOT EXISTS br_key text
  GENERATED ALWAYS AS (lead_manager.br_phone_key(value_raw)) STORED;

CREATE INDEX IF NOT EXISTS idx_contact_point_tenant_kind_brkey
  ON lead_manager.contact_point (tenant_id, kind, br_key);

-- ---------- BRECHA DA MIGR. 111 (fechada aqui) ----------
-- Com TODAS as abas cortando cedo por last_activity_at (ORDER BY ... NULLS LAST), uma conversa recém
-- criada e ainda SEM mensagem — o rascunho de renovação (migr. 097), aberto pelo gráfico — ficaria com
-- a coluna NULA e afundaria para o fim da lista, justo na aba Renovações, onde ela precisa aparecer.
-- Os gatilhos da 111 só cobrem INSERT de mensagem; o nascimento da conversa não tinha ninguém.
-- DEFAULT now() = a mesma régua do backfill da 111 (que caía em updated_at quando não havia mensagem).
ALTER TABLE lead_manager.conversations
  ALTER COLUMN last_activity_at SET DEFAULT now();

UPDATE lead_manager.conversations
   SET last_activity_at = updated_at
 WHERE last_activity_at IS NULL;

-- ---------- VALIDAÇÃO (tem de dar 0 nas duas) ----------
-- SELECT count(*) FROM lead_manager.conversations
--  WHERE br_key IS DISTINCT FROM lead_manager.br_phone_key(external_id);
-- SELECT count(*) FROM lead_manager.contact_point
--  WHERE br_key IS DISTINCT FROM lead_manager.br_phone_key(value_raw);

-- ROLLBACK (manual):
--   DROP INDEX IF EXISTS lead_manager.idx_conversations_tenant_brkey;
--   DROP INDEX IF EXISTS lead_manager.idx_contact_point_tenant_kind_brkey;
--   ALTER TABLE lead_manager.conversations DROP COLUMN IF EXISTS br_key;
--   ALTER TABLE lead_manager.contact_point DROP COLUMN IF EXISTS br_key;
--   (reverta o código junto — o inbox passa a ler cv.br_key/cp.br_key.)
