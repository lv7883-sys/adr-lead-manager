#!/usr/bin/env bash
# run-gate-matchkeys-hardening-itest.sh — provisão da itest do hardening BR-aware do gate.
# Sobe um Postgres DESCARTÁVEL (container efêmero), bootstrap (role + db + schema + tenants +
# migration 051 contact_roles + internal_contacts), exporta DATABASE_URL e roda a itest.
# NUNCA toca produção. A itest, por sua vez, insere fixtures em transação com ROLLBACK.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${ITEST_PG_PORT:-55433}"
CTR="lm-gate-mk-itest-pg"
TENANT="11111111-1111-1111-1111-111111111111"   # idem hardcode da itest

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

echo "[itest] bootstrap (role + db)…"
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<SQL
CREATE ROLE lead_manager_user LOGIN PASSWORD 'itest';
CREATE DATABASE lm_itest OWNER postgres;
SQL

echo "[itest] schema + tenants + search_path…"
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest >/dev/null <<SQL
CREATE SCHEMA lead_manager;
GRANT USAGE ON SCHEMA lead_manager TO lead_manager_user;
ALTER ROLE lead_manager_user SET search_path TO lead_manager, public;
CREATE TABLE lead_manager.tenants (id uuid PRIMARY KEY, name text);
INSERT INTO lead_manager.tenants (id, name) VALUES ('${TENANT}', 'itest');
GRANT SELECT ON lead_manager.tenants TO lead_manager_user;
-- internal_contacts (réplica do DDL de db/migrations/024, sem o resto da 024).
CREATE TABLE lead_manager.internal_contacts (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  phone      text NOT NULL,
  name       text NOT NULL,
  type       text NOT NULL CHECK (type IN ('gestor','recepcionista','professor','funcionario','parceiro','outro')),
  created_at timestamptz DEFAULT now(),
  UNIQUE (tenant_id, phone)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_manager.internal_contacts TO lead_manager_user;
SQL

echo "[itest] migration 051 (contact_role + contact_role_member, RLS + grants)…"
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest < "$ROOT/db/migrations/051_contact_roles.sql" >/dev/null

echo "[itest] rodando node --test…"
cd "$ROOT"
DATABASE_URL="postgres://lead_manager_user:itest@127.0.0.1:${PORT}/lm_itest" \
node --test test/gate-matchkeys-hardening.itest.js
