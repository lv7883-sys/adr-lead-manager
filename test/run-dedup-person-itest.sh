#!/usr/bin/env bash
# run-dedup-person-itest.sh — itest da FUSÃO de person duplicada + PREVENÇÃO no sync. PG DESCARTÁVEL
# + migrations mínimas (tabelas que a fusão toca). NUNCA toca produção.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${ITEST_PG_PORT:-55441}"
CTR="lm-dedupperson-itest-pg"
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

echo "[itest] bootstrap + migrations…"
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<SQL
CREATE ROLE lead_manager_user LOGIN PASSWORD 'itest';
CREATE DATABASE lm_itest OWNER postgres;
SQL
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest >/dev/null <<SQL
CREATE SCHEMA lead_manager;
CREATE TABLE lead_manager.tenants (id uuid PRIMARY KEY, name text);
INSERT INTO lead_manager.tenants (id, name)
  VALUES ('${TENANT_A}','A'), ('${TENANT_B}','B'), ('${VALINHOS}','Valinhos');
GRANT USAGE ON SCHEMA lead_manager TO lead_manager_user;
GRANT SELECT ON lead_manager.tenants TO lead_manager_user;
-- tenants_active(): o script lista tenants por aqui (dry-run/apply "todos").
CREATE FUNCTION public.tenants_active() RETURNS TABLE(tenant_id uuid)
  LANGUAGE sql AS \$\$ SELECT id FROM lead_manager.tenants WHERE name IN ('A','B') \$\$;
SQL
# tabelas que a fusão/prevenção tocam (mínimo, em ordem de dependência)
for m in 051_contact_roles 060_cadastro_mestre 061_person_data_nascimento 067_contact_point_tipo \
         068_person_payer_relation 069_canonical_roles_seed 070_field_provenance \
         092_renovacao_touchpoint 105_service_account_professor_person; do
  docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest < "$ROOT/db/migrations/${m}.sql" >/dev/null
done
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest >/dev/null <<SQL
SELECT lead_manager.seed_base_roles('${TENANT_A}');
SELECT lead_manager.seed_base_roles('${TENANT_B}');
SQL

echo "[itest] rodando node --test…"
cd "$ROOT"
DATABASE_URL="postgres://lead_manager_user:itest@127.0.0.1:${PORT}/lm_itest" \
RESOURCES_TENANT_A="$TENANT_A" RESOURCES_TENANT_B="$TENANT_B" \
JWT_SECRET="itest-secret" REDIS_URL="redis://127.0.0.1:6399" \
node --test test/dedup-person.itest.js
