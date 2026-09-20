#!/usr/bin/env bash
# run-origem-lead-itest.sh — itest da ORIGEM DO LEAD (migrations 170/171) num Postgres
# DESCARTÁVEL: schema lead_manager mínimo (tenants/leads) + 085_br_phone_key + as duas
# migrations novas, aplicadas DUAS VEZES (idempotência). A aplicação conecta como
# lead_manager_user — a RLS exercitada é a mesma de produção. NUNCA toca produção.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${ITEST_PG_PORT:-55472}"
CTR="lm-origem-lead-itest-pg"
TENANT_A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TENANT_B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

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

echo "[itest] bootstrap (role, banco, schema, tenants/leads mínimos)…"
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -q -U postgres -d postgres <<SQL
CREATE ROLE lead_manager_user LOGIN PASSWORD 'itest';
CREATE DATABASE lm_itest OWNER postgres;
SQL
psql_db <<SQL
CREATE SCHEMA lead_manager;
ALTER ROLE lead_manager_user SET search_path = lead_manager, public;
GRANT USAGE ON SCHEMA lead_manager TO lead_manager_user;

CREATE TABLE lead_manager.tenants (id uuid PRIMARY KEY, name text, lead_manager_active boolean NOT NULL DEFAULT true);
INSERT INTO lead_manager.tenants (id, name) VALUES ('${TENANT_A}','A'), ('${TENANT_B}','B');
GRANT SELECT ON lead_manager.tenants TO lead_manager_user;

-- leads: só o shape que a atribuição lê (id, tenant, phone, created_at), com a MESMA RLS de produção.
CREATE TABLE lead_manager.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  name text NOT NULL, phone text, status text NOT NULL DEFAULT 'new',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE lead_manager.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_manager.leads FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lead_manager.leads
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON lead_manager.leads TO lead_manager_user;
SQL

echo "[itest] migrations 085 + 170 + 171, duas vezes (idempotência)…"
for rodada in 1 2; do
  for m in 085_br_phone_key 170_mapa_campanha 171_origem_lead; do
    psql_db < "$ROOT/db/migrations/${m}.sql" >/dev/null
  done
done

echo "[itest] rodando node --test…"
cd "$ROOT"
DATABASE_URL="postgres://lead_manager_user:itest@127.0.0.1:${PORT}/lm_itest" \
ADMIN_DATABASE_URL="postgres://postgres:itest@127.0.0.1:${PORT}/lm_itest" \
LS_TENANT_A="$TENANT_A" LS_TENANT_B="$TENANT_B" \
node --test --test-concurrency=1 test/origem-lead.itest.js

echo "[itest] ok"
