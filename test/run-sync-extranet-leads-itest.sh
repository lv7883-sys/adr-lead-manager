#!/usr/bin/env bash
# run-sync-extranet-leads-itest.sh — itest do SYNC de leads da Extranet (migration 102). PG
# DESCARTÁVEL: tabelas auxiliares no shape prod (leads/eventos/config/autoapply pré-102, com RLS
# em leads p/ provar isolamento) + migrations 085 (br_phone_key) e 102 (espelho/modo/source).
# Snapshot SINTÉTICO (sem Extranet). NUNCA toca produção.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${ITEST_PG_PORT:-55471}"
CTR="lm-extranet-leads-itest-pg"
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

echo "[itest] bootstrap + schema…"
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<SQL
CREATE ROLE lead_manager_user LOGIN PASSWORD 'itest';
CREATE DATABASE lm_itest OWNER postgres;
SQL
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest >/dev/null <<SQL
CREATE SCHEMA lead_manager;
ALTER ROLE lead_manager_user SET search_path = lead_manager, public;
CREATE TABLE lead_manager.tenants (id uuid PRIMARY KEY, name text);
INSERT INTO lead_manager.tenants (id, name) VALUES ('${TENANT_A}','A'), ('${TENANT_B}','B');
GRANT USAGE ON SCHEMA lead_manager TO lead_manager_user;
GRANT SELECT ON lead_manager.tenants TO lead_manager_user;
SQL

echo "[itest] tabelas auxiliares (shape prod pré-102: leads c/ RLS + uq parcial de phone, eventos, config, autoapply 078)…"
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest >/dev/null <<SQL
CREATE TABLE lead_manager.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, name text, phone text, meta_psid text,
  status text, desfecho text, desfecho_em timestamptz, desfecho_source text, origem text,
  suggested_stage text, stage_reasoning text, stage_suggested_at timestamptz, suggested_stage_dismissed text,
  review_result text, review_by text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX uq_leads_tenant_phone ON lead_manager.leads (tenant_id, phone) WHERE phone IS NOT NULL;
ALTER TABLE lead_manager.leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lead_manager.leads
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
CREATE TABLE lead_manager.lead_eventos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, lead_id uuid, tipo text, autor text,
  conteudo text, etapa_key text, created_at timestamptz DEFAULT now());
CREATE TABLE lead_manager.tenant_lead_config (tenant_id uuid PRIMARY KEY, updated_at timestamptz DEFAULT now());
CREATE TABLE lead_manager.stage_autoapply_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES lead_manager.tenants(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES lead_manager.leads(id) ON DELETE CASCADE,
  from_stage text NOT NULL, to_stage text NOT NULL, reasoning text,
  source text NOT NULL DEFAULT 'event' CHECK (source IN ('event','backfill')),
  external_message_id text, prior_status text, prior_desfecho text, prior_desfecho_em timestamptz, evento_id uuid,
  reverted boolean NOT NULL DEFAULT false, reverted_at timestamptz, reverted_by text, created_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_manager.leads, lead_manager.lead_eventos,
  lead_manager.tenant_lead_config, lead_manager.stage_autoapply_log TO lead_manager_user;
SQL

echo "[itest] migrations 085 (br_phone_key) + 102 (extranet_lead)…"
for m in 085_br_phone_key 102_extranet_leads; do
  docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest < "$ROOT/db/migrations/${m}.sql" >/dev/null
done

echo "[itest] rodando node --test…"
cd "$ROOT"
DATABASE_URL="postgres://lead_manager_user:itest@127.0.0.1:${PORT}/lm_itest" \
RESOURCES_TENANT_A="$TENANT_A" RESOURCES_TENANT_B="$TENANT_B" \
JWT_SECRET="itest-secret" REDIS_URL="redis://127.0.0.1:6399" \
node --test test/sync-extranet-leads.itest.js
