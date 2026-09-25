#!/usr/bin/env bash
# run-fecha-por-contrato-itest.sh — itest do FECHAMENTO AUTOMÁTICO POR CONTRATO.
# PG DESCARTÁVEL: migrations do cadastro (person/contact_point/service_account/account_member) +
# 085 (br_phone_key) + tabelas auxiliares no shape prod. Cadastro SINTÉTICO. NUNCA toca produção.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${ITEST_PG_PORT:-55481}"
CTR="lm-fechacontrato-itest-pg"
TENANT_A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

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

echo "[itest] bootstrap…"
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<SQL
CREATE ROLE lead_manager_user LOGIN PASSWORD 'itest';
CREATE DATABASE lm_itest OWNER postgres;
SQL
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest >/dev/null <<SQL
CREATE SCHEMA lead_manager;
ALTER ROLE lead_manager_user SET search_path = lead_manager, public;
CREATE TABLE lead_manager.tenants (id uuid PRIMARY KEY, name text);
-- Valinhos entra só para satisfazer a FK do seed de papéis da migration 069 (mesmo motivo do
-- run-sync-cadastro-itest.sh). Nenhum teste usa este tenant.
INSERT INTO lead_manager.tenants (id, name)
  VALUES ('${TENANT_A}','A'), ('ed731a58-62e5-45ad-acba-a5502ff39e92','Valinhos (só p/ FK do seed)');
GRANT USAGE ON SCHEMA lead_manager TO lead_manager_user;
GRANT SELECT ON lead_manager.tenants TO lead_manager_user;
SQL

echo "[itest] migrations do cadastro + br_phone_key…"
for m in 051_contact_roles 060_cadastro_mestre 061_person_data_nascimento 067_contact_point_tipo \
         068_person_payer_relation 069_canonical_roles_seed 070_field_provenance 072_cadastro_sync \
         085_br_phone_key; do
  docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest < "$ROOT/db/migrations/${m}.sql" >/dev/null
done

echo "[itest] tabelas auxiliares (leads/eventos/autoapply/internos, shape prod)…"
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d lm_itest >/dev/null <<SQL
CREATE TABLE lead_manager.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, name text, phone text,
  status text, desfecho text, desfecho_em timestamptz, desfecho_source text, origem text,
  suggested_stage text, stage_reasoning text, stage_suggested_at timestamptz, suggested_stage_dismissed text,
  review_result text, review_by text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE lead_manager.lead_eventos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, lead_id uuid, tipo text, autor text,
  conteudo text, etapa_key text, created_at timestamptz DEFAULT now());
CREATE TABLE lead_manager.stage_autoapply_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, lead_id uuid NOT NULL,
  from_stage text NOT NULL, to_stage text NOT NULL, reasoning text, source text NOT NULL,
  external_message_id text, prior_status text, prior_desfecho text, prior_desfecho_em timestamptz,
  evento_id uuid, reverted boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE lead_manager.internal_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, phone text NOT NULL,
  name text NOT NULL, type text NOT NULL, created_at timestamptz DEFAULT now(),
  UNIQUE (tenant_id, phone));
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_manager.leads, lead_manager.lead_eventos,
  lead_manager.stage_autoapply_log, lead_manager.internal_contacts TO lead_manager_user;
SQL

echo "[itest] rodando node --test…"
cd "$ROOT"
DATABASE_URL="postgres://lead_manager_user:itest@127.0.0.1:${PORT}/lm_itest" \
RESOURCES_TENANT_A="$TENANT_A" \
JWT_SECRET="itest-secret" REDIS_URL="redis://127.0.0.1:6399" \
node --test test/fecha-por-contrato.itest.js
