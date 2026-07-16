-- ============================================================
-- ADR-037 fatia 037.2 (parte A) — data de nascimento na Pessoa (cadastro-mestre).
-- ADITIVA e não-destrutiva: só adiciona lead_manager.person.data_nascimento (nullable).
-- Usada para inferir menor/dependente na leitura (idade calculada relativa à data do evento;
-- nada é derivado/materializado aqui). NÃO altera RLS/posse/policies — a coluna herda tudo.
--
-- Migrations manuais, sem runner (NUNCA db push):
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 061_person_data_nascimento.sql
-- ============================================================

ALTER TABLE lead_manager.person
  ADD COLUMN IF NOT EXISTS data_nascimento date;   -- NULL = desconhecida (fonte não trouxe)

-- ROLLBACK (manual):
--   ALTER TABLE lead_manager.person DROP COLUMN IF EXISTS data_nascimento;
