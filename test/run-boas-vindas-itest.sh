#!/usr/bin/env bash
# run-boas-vindas-itest.sh — itests do BOAS-VINDAS (ADR-050): migrations 120–125 +
# db/grants/boas_vindas_agenda_read.sql (E17-01) e a rotina diária jobs/boas-vindas-sweep (E17-02).
# PG DESCARTÁVEL: schema lead_manager + cadastro (060/072/105…) + automacao_config/tenant_lead_config/
# internal_contacts mínimos + um schema `app` mínimo (só as 3 tabelas lidas). Migrations aplicadas DUAS
# vezes (idempotência). NUNCA toca produção.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${ITEST_PG_PORT:-55471}"
CTR="lm-boas-vindas-itest-pg"
TENANT_A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"   # itest das migrations
TENANT_B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
TENANT_C="cccccccc-cccc-4ccc-8ccc-cccccccccccc"   # itest da rotina (com agenda)
TENANT_D="dddddddd-dddd-4ddd-8ddd-dddddddddddd"   # itest da rotina (sem agenda)
TENANT_E="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"   # itest da recepção/configuração
TENANT_F="ffffffff-ffff-4fff-8fff-ffffffffffff"   # itest da recepção (isolamento)
VALINHOS="ed731a58-62e5-45ad-acba-a5502ff39e92"   # 060 semeia papéis de Valinhos

cleanup() { docker rm -f "$CTR" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
echo "[itest] subindo Postgres efêmero ($CTR) na porta $PORT…"
docker run --rm -d --name "$CTR" -e POSTGRES_PASSWORD=itest -p "127.0.0.1:${PORT}:5432" postgres:16-alpine >/dev/null

echo "[itest] aguardando readiness…"
ready=0
for i in $(seq 1 60); do
  if docker exec "$CTR" psql -U postgres -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
    sleep 1; docker exec "$CTR" psql -U postgres -d postgres -tAc 'SELECT 1' >/dev/null 2>&1 && { ready=1; break; }
  fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "[itest] Postgres não ficou pronto"; exit 1; }

psql_db() { docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -q -U postgres -d lm_itest; }

echo "[itest] bootstrap + schema…"
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -q -U postgres -d postgres <<SQL
CREATE ROLE lead_manager_user LOGIN PASSWORD 'itest';
CREATE DATABASE lm_itest OWNER postgres;
SQL
psql_db <<SQL
CREATE SCHEMA lead_manager;
ALTER ROLE lead_manager_user SET search_path = lead_manager, public;
CREATE TABLE lead_manager.tenants (id uuid PRIMARY KEY, name text, horario_comercial jsonb);
INSERT INTO lead_manager.tenants (id, name) VALUES
  ('${TENANT_A}','A'), ('${TENANT_B}','B'), ('${TENANT_C}','C'), ('${TENANT_D}','D'), ('${TENANT_E}','E'), ('${TENANT_F}','F'), ('${VALINHOS}','Valinhos');
GRANT USAGE ON SCHEMA lead_manager TO lead_manager_user;
GRANT SELECT ON lead_manager.tenants TO lead_manager_user;
SQL

echo "[itest] migrations do cadastro (person/service_account/professor…)…"
for m in 051_contact_roles 060_cadastro_mestre 061_person_data_nascimento 067_contact_point_tipo \
         068_person_payer_relation 069_canonical_roles_seed 070_field_provenance 072_cadastro_sync \
         105_service_account_professor_person; do
  psql_db < "$ROOT/db/migrations/${m}.sql" >/dev/null
done

echo "[itest] tabelas mínimas (shape de produção) …"
psql_db <<SQL
CREATE TABLE lead_manager.automacao_config (tenant_id uuid PRIMARY KEY, nome_ia text, contexto_ia text,
  ramo_atividade text, objetivo_conversa text, estilo_ia text, comportamento_ia text, nao_falar text[] NOT NULL DEFAULT '{}');
CREATE TABLE lead_manager.tenant_lead_config (tenant_id uuid PRIMARY KEY, school_name text);
INSERT INTO lead_manager.tenant_lead_config VALUES ('${TENANT_C}', 'Escola C');
CREATE TABLE lead_manager.internal_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
  phone text NOT NULL, name text NOT NULL, type text NOT NULL, created_at timestamptz DEFAULT now(), UNIQUE (tenant_id, phone));
CREATE OR REPLACE FUNCTION lead_manager.br_phone_key(x text) RETURNS text LANGUAGE sql IMMUTABLE AS \$fn\$
  WITH d AS (SELECT regexp_replace(coalesce(x, ''), '[^0-9]', '', 'g') AS v),
       loc AS (SELECT CASE WHEN length(v) IN (12,13) AND left(v,2)='55' THEN substr(v,3) ELSE v END AS v FROM d)
  SELECT CASE WHEN length(v)=11 AND substr(v,3,1)='9' THEN left(v,2)||substr(v,4) ELSE v END FROM loc
\$fn\$;
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_manager.automacao_config, lead_manager.tenant_lead_config, lead_manager.internal_contacts TO lead_manager_user;
-- Conversas: só o shape que a fila da recepção lê (br_key gerada, como na migr. 112).
CREATE TABLE lead_manager.conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
  channel text NOT NULL DEFAULT 'whatsapp', external_id text NOT NULL, conversation_kind text DEFAULT 'DIRECT',
  last_activity_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  br_key text GENERATED ALWAYS AS (lead_manager.br_phone_key(external_id)) STORED, UNIQUE (tenant_id, channel, external_id));
ALTER TABLE lead_manager.conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lead_manager.conversations
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON lead_manager.conversations TO lead_manager_user;
SQL

echo "[itest] grants SEM schema app (deve só avisar)…"
psql_db < "$ROOT/db/grants/boas_vindas_agenda_read.sql"

echo "[itest] migrations 120–125, duas vezes (idempotência)…"
for rodada in 1 2; do
  for m in 120_boas_vindas_config 121_boas_vindas_modelo 122_boas_vindas_anexo 123_boas_vindas_etapa \
           124_boas_vindas_toque 125_boas_vindas_modelo_escola_musica; do
    psql_db < "$ROOT/db/migrations/${m}.sql" >/dev/null
  done
done

echo "[itest] schema app mínimo (Scheduler) + grants…"
psql_db <<SQL
CREATE SCHEMA app;
CREATE TABLE app.franquia (id serial PRIMARY KEY, slug text, lead_tenant_id uuid, evolution_token_enc text);
CREATE TABLE app.agenda_snapshot (franquia_id int NOT NULL REFERENCES app.franquia(id), semana date NOT NULL,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb, scraped_em timestamptz NOT NULL DEFAULT now(), erro text, PRIMARY KEY (franquia_id, semana));
CREATE TABLE app.cache_identidade_aula (franquia_id int NOT NULL, aluno_norm text NOT NULL, curso_norm text NOT NULL,
  id_aluno int, id_curso int, id_contrato int, id_turma int, PRIMARY KEY (franquia_id, aluno_norm, curso_norm));
SQL
psql_db < "$ROOT/db/grants/boas_vindas_agenda_read.sql"
psql_db < "$ROOT/db/grants/boas_vindas_agenda_read.sql"

echo "[itest] rodando node --test…"
cd "$ROOT"
DATABASE_URL="postgres://lead_manager_user:itest@127.0.0.1:${PORT}/lm_itest" \
ADMIN_DATABASE_URL="postgres://postgres:itest@127.0.0.1:${PORT}/lm_itest" \
RESOURCES_TENANT_A="$TENANT_A" RESOURCES_TENANT_B="$TENANT_B" BV_TENANT_C="$TENANT_C" BV_TENANT_D="$TENANT_D" \
BV_TENANT_E="$TENANT_E" BV_TENANT_F="$TENANT_F" BV_ITEST_APP=1 \
JWT_SECRET="itest-secret" REDIS_URL="redis://127.0.0.1:6399" \
node --test --test-concurrency=1 test/boas-vindas-migrations.itest.js test/boas-vindas-sweep.itest.js test/boas-vindas-recepcao.itest.js
