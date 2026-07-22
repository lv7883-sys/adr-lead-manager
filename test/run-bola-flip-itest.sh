#!/usr/bin/env bash
# run-bola-flip-itest.sh — itest do FLIP da bola (ADR-030 Fatia 0). PG DESCARTÁVEL: tabela leads
# mínima + migração 070 (proveniência, p/ o revert). Testa _aplicarEstadoBola + gateSaida.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${ITEST_PG_PORT:-55440}"
CTR="lm-bola-itest-pg"
A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; VAL="ed731a58-62e5-45ad-acba-a5502ff39e92"
cleanup() { docker rm -f "$CTR" >/dev/null 2>&1 || true; }
trap cleanup EXIT; cleanup
echo "[itest] Postgres efêmero ($CTR):$PORT…"
docker run --rm -d --name "$CTR" -e POSTGRES_PASSWORD=itest -p "127.0.0.1:${PORT}:5432" postgres:16-alpine >/dev/null
for i in $(seq 1 60); do docker exec "$CTR" psql -U postgres -d postgres -tAc 'SELECT 1' >/dev/null 2>&1 && { sleep 1; break; }; sleep 1; done
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<SQL
CREATE ROLE lead_manager_user LOGIN PASSWORD 'itest';
ALTER ROLE lead_manager_user SET search_path = lead_manager, public;
CREATE DATABASE lm_itest OWNER postgres;
SQL
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest >/dev/null <<SQL
CREATE SCHEMA lead_manager;
CREATE TABLE lead_manager.tenants (id uuid PRIMARY KEY, name text);
INSERT INTO lead_manager.tenants VALUES ('${A}','A'),('${B}','B'),('${VAL}','Valinhos');
-- leads MÍNIMO (só as colunas que _aplicarEstadoBola toca) + RLS FORCE (prova cross-tenant)
CREATE TABLE lead_manager.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES lead_manager.tenants(id),
  conversation_state text, state_reasoning text, state_computed_at timestamptz,
  bola_nossa_desde timestamptz, adiamentos int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE lead_manager.leads OWNER TO lead_manager_user;
ALTER TABLE lead_manager.leads ENABLE ROW LEVEL SECURITY; ALTER TABLE lead_manager.leads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lead_manager.leads
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT USAGE ON SCHEMA lead_manager TO lead_manager_user;
GRANT SELECT ON lead_manager.tenants TO lead_manager_user;
SQL
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest < "$ROOT/db/migrations/070_field_provenance.sql" >/dev/null
echo "[itest] node --test…"
cd "$ROOT"
DATABASE_URL="postgres://lead_manager_user:itest@127.0.0.1:${PORT}/lm_itest" \
RESOURCES_TENANT_A="$A" RESOURCES_TENANT_B="$B" JWT_SECRET="itest" REDIS_URL="redis://127.0.0.1:6399" \
node --test test/bola-flip.itest.js
