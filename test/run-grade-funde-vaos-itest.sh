#!/usr/bin/env bash
# run-grade-funde-vaos-itest.sh — provisão da itest do FUSÃO de vãos adjacentes com continuidade de
# recurso na grade-recorrente.
# Postgres DESCARTÁVEL + migrations 046, 048, 050. Bate na rota real via Express efêmero. NUNCA
# toca produção nem a Extranet.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${ITEST_PG_PORT:-55439}"
CTR="lm-grade-funde-vaos-itest-pg"
TENANT_A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TENANT_B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

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
    sleep 1
    docker exec "$CTR" psql -U postgres -d postgres -tAc 'SELECT 1' >/dev/null 2>&1 && { ready=1; break; }
  fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "[itest] Postgres não ficou pronto"; exit 1; }

echo "[itest] bootstrap (role + db + tenants + horário) + migrations 046, 048, 050…"
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<SQL
CREATE ROLE lead_manager_user LOGIN PASSWORD 'itest';
ALTER ROLE lead_manager_user SET search_path = lead_manager, resources, public;
CREATE DATABASE lm_itest OWNER postgres;
SQL
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest >/dev/null <<SQL
CREATE SCHEMA lead_manager;
CREATE TABLE lead_manager.tenants (id uuid PRIMARY KEY, name text, horario_comercial jsonb,
  horario_comercial_inicio time, horario_comercial_fim time, horario_comercial_dias smallint[]);
INSERT INTO lead_manager.tenants (id, name) VALUES ('${TENANT_A}','itest-A'), ('${TENANT_B}','itest-B');
-- TENANT_A: seg–sex 09:00–22:00, sáb 09:00–13:00.
UPDATE lead_manager.tenants SET horario_comercial = '{
  "1":[{"inicio":"09:00","fim":"22:00"}], "2":[{"inicio":"09:00","fim":"22:00"}],
  "3":[{"inicio":"09:00","fim":"22:00"}], "4":[{"inicio":"09:00","fim":"22:00"}],
  "5":[{"inicio":"09:00","fim":"22:00"}], "6":[{"inicio":"09:00","fim":"13:00"}]
}'::jsonb WHERE id = '${TENANT_A}';
GRANT USAGE ON SCHEMA lead_manager TO lead_manager_user;
GRANT SELECT ON lead_manager.tenants TO lead_manager_user;
SQL
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest < "$ROOT/db/migrations/046_resources_recorrente.sql" >/dev/null
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest < "$ROOT/db/migrations/048_resources_datado.sql"     >/dev/null
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest < "$ROOT/db/migrations/050_occupation_slot_end.sql"  >/dev/null

echo "[itest] rodando node --test…"
cd "$ROOT"
DATABASE_URL="postgres://lead_manager_user:itest@127.0.0.1:${PORT}/lm_itest" \
RESOURCES_TENANT_A="$TENANT_A" \
RESOURCES_TENANT_B="$TENANT_B" \
JWT_SECRET="itest-secret" \
node --test test/grade-funde-vaos.itest.js
