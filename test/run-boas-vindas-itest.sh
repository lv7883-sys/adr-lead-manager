#!/usr/bin/env bash
# run-boas-vindas-itest.sh — itest das migrations de BOAS-VINDAS (ADR-050, E17-01): 120–125 +
# db/grants/boas_vindas_agenda_read.sql. PG DESCARTÁVEL: schema lead_manager + cadastro (060/072…) +
# automacao_config mínima + um schema `app` mínimo (só as 3 tabelas lidas). Migrations aplicadas DUAS
# vezes (idempotência). NUNCA toca produção.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${ITEST_PG_PORT:-55471}"
CTR="lm-boas-vindas-itest-pg"
TENANT_A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TENANT_B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
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
CREATE TABLE lead_manager.tenants (id uuid PRIMARY KEY, name text);
INSERT INTO lead_manager.tenants (id, name) VALUES ('${TENANT_A}','A'), ('${TENANT_B}','B'), ('${VALINHOS}','Valinhos');
GRANT USAGE ON SCHEMA lead_manager TO lead_manager_user;
GRANT SELECT ON lead_manager.tenants TO lead_manager_user;
SQL

echo "[itest] migrations do cadastro (person/service_account…)…"
for m in 051_contact_roles 060_cadastro_mestre 061_person_data_nascimento 067_contact_point_tipo \
         068_person_payer_relation 069_canonical_roles_seed 070_field_provenance 072_cadastro_sync; do
  psql_db < "$ROOT/db/migrations/${m}.sql" >/dev/null
done

echo "[itest] automacao_config mínima (shape de produção até a 119)…"
psql_db <<SQL
CREATE TABLE lead_manager.automacao_config (tenant_id uuid PRIMARY KEY, nome_ia text, contexto_ia text,
  ramo_atividade text, objetivo_conversa text, estilo_ia text, comportamento_ia text, nao_falar text[] NOT NULL DEFAULT '{}');
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_manager.automacao_config TO lead_manager_user;
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
RESOURCES_TENANT_A="$TENANT_A" RESOURCES_TENANT_B="$TENANT_B" BV_ITEST_APP=1 \
JWT_SECRET="itest-secret" REDIS_URL="redis://127.0.0.1:6399" \
node --test test/boas-vindas-migrations.itest.js
