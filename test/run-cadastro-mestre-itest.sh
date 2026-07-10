#!/usr/bin/env bash
# run-cadastro-mestre-itest.sh — prova da migration 060_cadastro_mestre (ADR-037 037.1) contra
# um Postgres DESCARTÁVEL. Bootstrap (role NÃO-superuser + db + schema + tenants) → migration 051
# (contact_role/member, dependência) → migration 060 → itest de isolamento/FORCE. NUNCA toca produção.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${ITEST_PG_PORT:-55434}"
CTR="lm-cadmestre-itest-pg"
VALINHOS="ed731a58-62e5-45ad-acba-a5502ff39e92"

cleanup() { docker rm -f "$CTR" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "[itest] subindo Postgres efêmero ($CTR) na porta $PORT…"
docker run --rm -d --name "$CTR" -e POSTGRES_PASSWORD=itest -p "127.0.0.1:${PORT}:5432" postgres:16-alpine >/dev/null
echo "[itest] aguardando readiness…"
for i in $(seq 1 30); do docker exec "$CTR" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done

echo "[itest] bootstrap (role lead_manager_user NÃO-superuser + db)…"
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<SQL
CREATE ROLE lead_manager_user LOGIN PASSWORD 'itest';   -- sem SUPERUSER, sem BYPASSRLS (fiel a prod, D9)
CREATE DATABASE lm_itest OWNER postgres;
SQL

echo "[itest] schema + tenants (Valinhos + A + B) + search_path…"
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest >/dev/null <<SQL
CREATE SCHEMA lead_manager;
GRANT USAGE, CREATE ON SCHEMA lead_manager TO lead_manager_user;
ALTER ROLE lead_manager_user SET search_path TO lead_manager, public;
CREATE TABLE lead_manager.tenants (id uuid PRIMARY KEY, name text);
INSERT INTO lead_manager.tenants (id, name) VALUES
  ('${VALINHOS}','valinhos'),
  ('11111111-1111-1111-1111-111111111111','tenant-A'),
  ('22222222-2222-2222-2222-222222222222','tenant-B');
GRANT SELECT ON lead_manager.tenants TO lead_manager_user;
SQL

echo "[itest] migration 051 (contact_role + contact_role_member — dependência)…"
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest < "$ROOT/db/migrations/051_contact_roles.sql" >/dev/null

echo "[itest] >>> migration 060_cadastro_mestre (a que está sendo testada) <<<"
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest < "$ROOT/db/migrations/060_cadastro_mestre.sql"
echo "[itest] migration 060 aplicou SEM erro ✅"

echo "[itest] rodando node --test…"
cd "$ROOT"
DATABASE_URL="postgres://lead_manager_user:itest@127.0.0.1:${PORT}/lm_itest" \
node --test test/cadastro-mestre.itest.js
