-- ============================================================================
-- plataforma_contratacao_read.sql — leitura da CONTRATAÇÃO pelo Lead Manager.
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 \
--     -f db/grants/plataforma_contratacao_read.sql
--
-- POR QUÊ
--   A fonte única de contratação é `plataforma.assinatura` (ADR-051, D9) — que ainda não
--   existe. Até lá, a resposta para "esta unidade contratou este módulo?" vem de
--   `app.tenant_modules` (schema do Scheduler), por UM ÚNICO ponto de leitura no código:
--   `src/plataforma/licenca.js`. Este arquivo dá a esse ponto o direito de ler, e nada mais:
--   SELECT em duas tabelas, nenhuma escrita.
--
--   `app.franquia.lead_tenant_id` (migr. 063 do Scheduler) é a ponte entre o id de franquia
--   e o uuid da unidade no Lead Manager.
--
-- Idempotente. Se o schema `app` não existir (banco de teste só do LM), apenas avisa.
-- Rodar de novo depois da Fase 6 do ADR-051 para REVOGAR: quando a leitura passar a ser
-- `plataforma.assinatura`, estes grants deixam de ser necessários.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'app') THEN
    RAISE NOTICE 'schema "app" não existe neste banco — nada a conceder (ok em banco só do LM)';
    RETURN;
  END IF;

  EXECUTE 'GRANT USAGE ON SCHEMA app TO lead_manager_user';

  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'app' AND tablename = 'tenant_modules') THEN
    EXECUTE 'GRANT SELECT ON app.tenant_modules TO lead_manager_user';
  ELSE
    RAISE NOTICE 'app.tenant_modules não existe — a contratação vai responder "sem contratação" para todo mundo';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'app' AND tablename = 'franquia') THEN
    EXECUTE 'GRANT SELECT ON app.franquia TO lead_manager_user';
  ELSE
    RAISE NOTICE 'app.franquia não existe — sem a ponte franquia -> unidade não há o que ler';
  END IF;
END $$;
