-- ============================================================
-- 187 — `is_demo` no tenant do Lead Manager: o PORTÃO do seed de demonstração.
--
-- POR QUE UMA COLUNA, E NÃO UM `if` NO SCRIPT
--
-- Em 04/11/2026 o sistema é demonstrado à MF8 com dados fictícios. O dashboard já tem
-- `app.franquia.is_demo` (série dele, migr 183) e dele dependem as travas de contenção dos
-- efeitos externos do Compasso/Fiscal. O Lead Manager é OUTRO schema no MESMO banco e não
-- tinha equivalente: o seed do LM não tinha como RECUSAR gravar na unidade errada.
--
-- A trava que importa não é o `if` no JavaScript — é o fato de que a gravação do cenário
-- resolve o tenant por uma SUBCONSULTA que exige `is_demo`:
--
--     INSERT ... VALUES ((SELECT id FROM lead_manager.tenants WHERE id = $1 AND is_demo), ...)
--
-- Em tenant que não é de demonstração a subconsulta devolve NULL, a coluna é NOT NULL, e a
-- transação inteira cai. Não existe versão da instrução sem o portão — e o modo de falha é o
-- seguro: errar grava NADA, nunca grava na unidade real. É a mesma lição que o dashboard
-- escreveu em `lib/demo-seed.js` ("a trava de verdade é SQL e não JavaScript").
--
-- DEFAULT false, NOT NULL: num banco com esta migração aplicada e nada mais, TODO tenant
-- existente (ADR Valinhos) continua sendo tenant real, e o seed recusa todos eles. A migração
-- liga a possibilidade do portão; quem marca uma unidade como de demonstração é o
-- provisionamento, explicitamente.
--
-- ADITIVA: 1 ADD COLUMN IF NOT EXISTS. Nada de DROP, nada destrutivo, nenhum dado alterado.
-- Faixa 187 reservada em db/migrations/RESERVAS.md (frente "demonstração MF8").
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f 187_tenant_demo.sql
-- ============================================================

ALTER TABLE lead_manager.tenants
  ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN lead_manager.tenants.is_demo IS
  'Unidade de DEMONSTRAÇÃO (dados fictícios). Portão do seed: a gravação do cenário resolve o '
  'tenant por subconsulta que exige esta flag — sem ela, zero linhas gravadas. Espelha '
  'app.franquia.is_demo da série do dashboard (migr 183). NÃO substitui lead_manager_active '
  '= false, que é o que tira a unidade dos laços de fundo (tenants_active(), migr 031).';

-- Conferência (read-only) — quem é de demonstração hoje:
--   SELECT id, name, lead_manager_active, is_demo FROM lead_manager.tenants ORDER BY name;
-- O esperado logo após esta migração: TODAS as linhas com is_demo = false.

-- ROLLBACK (manual):
--   ALTER TABLE lead_manager.tenants DROP COLUMN IF EXISTS is_demo;
--   ⚠ Derrubar a coluna NÃO apaga o cenário já gravado — apaga o PORTÃO. Se o objetivo é
--     remover a demonstração, apague o tenant primeiro (ON DELETE CASCADE leva o cenário):
--       DELETE FROM lead_manager.tenants WHERE id = '<uuid>' AND is_demo;
