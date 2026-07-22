#!/usr/bin/env bash
# run-role-lead-policy-itest.sh — itest da política papel→resgate (ADR-036 E1.4/E1.5).
# PG DESCARTÁVEL + migrations até 071. Semeia tenants A/B (+C/Valinhos p/ FKs/seed do 060/071).
# NUNCA toca produção.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${ITEST_PG_PORT:-55438}"
CTR="lm-rlp-itest-pg"
TENANT_A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TENANT_B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
TENANT_C="cccccccc-cccc-4ccc-8ccc-cccccccccccc"
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
  VALUES ('${TENANT_A}','A'), ('${TENANT_B}','B'), ('${TENANT_C}','C'), ('${VALINHOS}','Valinhos');
GRANT USAGE ON SCHEMA lead_manager TO lead_manager_user;
GRANT SELECT ON lead_manager.tenants TO lead_manager_user;
SQL
for m in 051_contact_roles 060_cadastro_mestre 061_person_data_nascimento 067_contact_point_tipo 068_person_payer_relation 069_canonical_roles_seed 070_field_provenance 071_role_lead_policy; do
  docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest < "$ROOT/db/migrations/${m}.sql" >/dev/null
done

echo "[itest] rodando node --test…"
cd "$ROOT"
DATABASE_URL="postgres://lead_manager_user:itest@127.0.0.1:${PORT}/lm_itest" \
RESOURCES_TENANT_A="$TENANT_A" RESOURCES_TENANT_B="$TENANT_B" RESOURCES_TENANT_C="$TENANT_C" \
JWT_SECRET="itest-secret" REDIS_URL="redis://127.0.0.1:6399" \
node --test test/role-lead-policy.itest.js
