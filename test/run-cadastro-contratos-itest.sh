#!/usr/bin/env bash
# run-cadastro-contratos-itest.sh — provisão da itest de ingestão do cadastro-mestre (037.2).
# PG DESCARTÁVEL + migrations 051/060/061. Semeia o tenant Valinhos (060 insere contact_role
# com FK a ele). NUNCA toca produção.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${ITEST_PG_PORT:-55436}"
CTR="lm-cad-itest-pg"
TENANT_A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TENANT_B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
VALINHOS="ed731a58-62e5-45ad-acba-a5502ff39e92"

cleanup() { docker rm -f "$CTR" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
echo "[itest] subindo Postgres efêmero ($CTR) na porta $PORT…"
docker run --rm -d --name "$CTR" -e POSTGRES_PASSWORD=itest \
  -p "127.0.0.1:${PORT}:5432" postgres:16-alpine >/dev/null

echo "[itest] aguardando readiness…"
ready=0
for i in $(seq 1 60); do
  if docker exec "$CTR" psql -U postgres -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
    sleep 1; docker exec "$CTR" psql -U postgres -d postgres -tAc 'SELECT 1' >/dev/null 2>&1 && { ready=1; break; }
  fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "[itest] Postgres não ficou pronto"; exit 1; }

echo "[itest] bootstrap + migrations 051/060/061…"
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
SQL
for m in 051_contact_roles 060_cadastro_mestre 061_person_data_nascimento; do
  docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest < "$ROOT/db/migrations/${m}.sql" >/dev/null
done

echo "[itest] rodando node --test…"
cd "$ROOT"
DATABASE_URL="postgres://lead_manager_user:itest@127.0.0.1:${PORT}/lm_itest" \
RESOURCES_TENANT_A="$TENANT_A" RESOURCES_TENANT_B="$TENANT_B" \
JWT_SECRET="itest-secret" REDIS_URL="redis://127.0.0.1:6399" \
node --test test/cadastro-contratos.itest.js
