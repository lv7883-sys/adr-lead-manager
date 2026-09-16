-- ============================================================================
-- Grant de leitura cross-schema para a régua de BOAS-VINDAS (ADR-050 §8).
--
-- O adaptador "academia-do-rock" precisa de dia e horário das aulas do aluno. A fonte é a agenda que
-- o Scheduler já raspa da Extranet toda semana — sem duplicar nem sincronizar:
--   app.agenda_snapshot        grade semanal (aulasPorDia: aluno, data, hora_inicio, hora_fim, prof…)
--   app.cache_identidade_aula  (aluno, curso) → id_aluno / id_contrato reais da Extranet
--   app.franquia               lead_tenant_id: resolve tenant → franquia, SEM fallback (migr. 063 do Scheduler)
--
-- READ-ONLY. Nada do Scheduler nem do Diapasão é alterado. Idempotente. Em banco sem o schema `app`
-- (itest/DEV do LM) não faz nada e só avisa — não quebra o provisionamento.
--
-- ⚠ O schema `app` NÃO tem RLS: o isolamento por unidade é do adaptador, que filtra por franquia_id
-- resolvida a partir do tenant e, sem franquia explícita, não lê nada.
--
--   docker exec -i <pg> psql -U postgres -d adr_scheduler -v ON_ERROR_STOP=1 -f boas_vindas_agenda_read.sql
-- ============================================================================
DO $grant$
BEGIN
  IF to_regnamespace('app') IS NULL THEN
    RAISE NOTICE 'boas-vindas: schema app ausente — grants de agenda ignorados (esperado fora do banco compartilhado)';
    RETURN;
  END IF;
  EXECUTE 'GRANT USAGE ON SCHEMA app TO lead_manager_user';
  IF to_regclass('app.agenda_snapshot') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON app.agenda_snapshot TO lead_manager_user';
  ELSE
    RAISE NOTICE 'boas-vindas: app.agenda_snapshot ausente';
  END IF;
  IF to_regclass('app.cache_identidade_aula') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON app.cache_identidade_aula TO lead_manager_user';
  ELSE
    RAISE NOTICE 'boas-vindas: app.cache_identidade_aula ausente';
  END IF;
  IF to_regclass('app.franquia') IS NOT NULL THEN
    -- Só as colunas de que o adaptador precisa (a franquia guarda credenciais cifradas da Evolution).
    EXECUTE 'GRANT SELECT (id, lead_tenant_id) ON app.franquia TO lead_manager_user';
  ELSE
    RAISE NOTICE 'boas-vindas: app.franquia ausente';
  END IF;
END
$grant$;
