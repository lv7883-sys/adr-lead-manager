#!/usr/bin/env bash
# run-resources-sync-itest.sh — provisão da itest do Sincronizador (ADR-026).
# Sobe um Postgres DESCARTÁVEL (container efêmero), bootstrap + migration 046, exporta
# os envs e roda test/resources-sync.itest.js. NUNCA toca produção.
#
# Fixtures (HTML real da Extranet, com PII) NÃO são versionados — passe o caminho:
#   RESOURCES_FIXTURES=/caminho/com/{raw,raw-cad,raw-cad28} test/run-resources-sync-itest.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${ITEST_PG_PORT:-55432}"
CTR="lm-res-itest-pg"
TENANT="${RESOURCES_TENANT_ID:-11111111-1111-1111-1111-111111111111}"
OTHER="22222222-2222-2222-2222-222222222222"   # idem hardcode da itest
: "${RESOURCES_FIXTURES:?defina RESOURCES_FIXTURES=/dir/com/{raw,raw-cad,raw-cad28}}"

cleanup() { docker rm -f "$CTR" >/dev/null 2>&1 || true; }
trap cleanup EXIT

cleanup
echo "[itest] subindo Postgres efêmero ($CTR) na porta $PORT…"
docker run --rm -d --name "$CTR" -e POSTGRES_PASSWORD=itest \
  -p "127.0.0.1:${PORT}:5432" postgres:16-alpine >/dev/null

echo "[itest] aguardando readiness…"
for i in $(seq 1 30); do
  docker exec "$CTR" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

echo "[itest] bootstrap (role + db + lead_manager.tenants) + migration 046…"
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<SQL
CREATE ROLE lead_manager_user LOGIN PASSWORD 'itest';
CREATE DATABASE lm_itest OWNER postgres;
SQL
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest >/dev/null <<SQL
CREATE SCHEMA lead_manager;
CREATE TABLE lead_manager.tenants (id uuid PRIMARY KEY, name text);
INSERT INTO lead_manager.tenants (id, name) VALUES ('${TENANT}','itest'), ('${OTHER}','other');
GRANT USAGE ON SCHEMA lead_manager TO lead_manager_user;
GRANT SELECT ON lead_manager.tenants TO lead_manager_user;
SQL
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest < "$ROOT/db/migrations/046_resources_recorrente.sql" >/dev/null

echo "[itest] rodando node --test…"
cd "$ROOT"
DATABASE_URL="postgres://lead_manager_user:itest@127.0.0.1:${PORT}/lm_itest" \
RESOURCES_TENANT_ID="$TENANT" \
RESOURCES_FIXTURES="$RESOURCES_FIXTURES" \
node --test test/resources-sync.itest.js
