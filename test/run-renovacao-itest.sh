#!/usr/bin/env bash
# run-renovacao-itest.sh — itest da RENOVAÇÃO Fase 1 (migration 091 + jobs/renovacao-sweep). PG
# DESCARTÁVEL: schema lead_manager + migrations do cadastro (person/contact_point/service_account/
# account_member + soft-delete 072) + automacao_config/tenant_lead_config mínimos + a própria 091.
# Sem Extranet e sem Gemini real (o teste injeta um fake). NUNCA toca produção.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${ITEST_PG_PORT:-55463}"
CTR="lm-renovacao-itest-pg"
TENANT_A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TENANT_B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
VALINHOS="ed731a58-62e5-45ad-acba-a5502ff39e92"

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

echo "[itest] bootstrap + schema…"
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<SQL
CREATE ROLE lead_manager_user LOGIN PASSWORD 'itest';
CREATE DATABASE lm_itest OWNER postgres;
SQL
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest >/dev/null <<SQL
CREATE SCHEMA lead_manager;
ALTER ROLE lead_manager_user SET search_path = lead_manager, public;
CREATE TABLE lead_manager.tenants (id uuid PRIMARY KEY, name text);
INSERT INTO lead_manager.tenants (id, name) VALUES ('${TENANT_A}','A'), ('${TENANT_B}','B'), ('${VALINHOS}','Valinhos');
GRANT USAGE ON SCHEMA lead_manager TO lead_manager_user;
GRANT SELECT ON lead_manager.tenants TO lead_manager_user;
SQL

echo "[itest] migrations do cadastro (person/contact_point/service_account/account_member + soft-delete 072) …"
for m in 051_contact_roles 060_cadastro_mestre 061_person_data_nascimento 067_contact_point_tipo \
         068_person_payer_relation 069_canonical_roles_seed 070_field_provenance 072_cadastro_sync; do
  docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest < "$ROOT/db/migrations/${m}.sql" >/dev/null
done

echo "[itest] config mínima (automacao_config/tenant_lead_config — shape usado pelo sweep) …"
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest >/dev/null <<SQL
CREATE TABLE lead_manager.automacao_config (tenant_id uuid PRIMARY KEY, nome_ia text, contexto_ia text);
CREATE TABLE lead_manager.tenant_lead_config (tenant_id uuid PRIMARY KEY, school_name text, updated_at timestamptz DEFAULT now());
-- Contatos internos (ADR-018) + br_phone_key (espelho da migr 085) — usados pela exclusão de internos no sweep.
CREATE TABLE lead_manager.internal_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, phone text, name text, type text);
CREATE OR REPLACE FUNCTION lead_manager.br_phone_key(x text) RETURNS text LANGUAGE sql IMMUTABLE AS \$fn\$
  WITH d AS (SELECT regexp_replace(coalesce(x, ''), '[^0-9]', '', 'g') AS v),
       loc AS (SELECT CASE WHEN length(v) IN (12,13) AND left(v,2)='55' THEN substr(v,3) ELSE v END AS v FROM d)
  SELECT CASE WHEN length(v)=11 AND substr(v,3,1)='9' THEN left(v,2)||substr(v,4) ELSE v END FROM loc
\$fn\$;
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_manager.automacao_config, lead_manager.tenant_lead_config, lead_manager.internal_contacts TO lead_manager_user;
SQL

echo "[itest] migration 092 (renovacao_touchpoint + toggles) …"
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest < "$ROOT/db/migrations/092_renovacao_touchpoint.sql" >/dev/null

echo "[itest] rodando node --test…"
cd "$ROOT"
DATABASE_URL="postgres://lead_manager_user:itest@127.0.0.1:${PORT}/lm_itest" \
RESOURCES_TENANT_A="$TENANT_A" RESOURCES_TENANT_B="$TENANT_B" \
JWT_SECRET="itest-secret" REDIS_URL="redis://127.0.0.1:6399" \
node --test test/renovacao-sweep.itest.js
