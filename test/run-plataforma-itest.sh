#!/usr/bin/env bash
# run-plataforma-itest.sh — SUÍTE BLOQUEANTE de isolamento entre unidades, num Postgres
# DESCARTÁVEL. Aplica 172 (núcleo de plataforma) e 173 (motor de marketing) DUAS VEZES
# (idempotência) e roda test/isolamento-tenant.itest.js como lead_manager_user — não como
# superuser, senão a RLS seria contornada e o teste provaria nada. NUNCA toca produção.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${ITEST_PG_PORT:-55473}"
CTR="lm-plataforma-itest-pg"
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
    sleep 1; docker exec "$CTR" psql -U postgres -d postgres -tAc 'SELECT 1' >/dev/null 2>&1 && { ready=1; break; }
  fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "[itest] Postgres não ficou pronto"; exit 1; }

psql_db() { docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -q -U postgres -d lm_itest; }

echo "[itest] bootstrap (role da aplicação + banco)…"
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -q -U postgres -d postgres <<SQL
CREATE ROLE lead_manager_user LOGIN PASSWORD 'itest';
CREATE DATABASE lm_itest OWNER postgres;
SQL

echo "[itest] schema app mínimo (fonte da contratação, do Scheduler)…"
psql_db <<SQL
CREATE SCHEMA app;
-- shape real do Scheduler: app.franquia.lead_tenant_id (migr. 063) é a ponte para a unidade,
-- e app.tenant_modules diz quais módulos ela contratou. Sem RLS, como em produção.
CREATE TABLE app.franquia (
  id serial PRIMARY KEY, slug text UNIQUE NOT NULL, nome text NOT NULL, lead_tenant_id uuid);
CREATE TABLE app.tenant_modules (
  franquia_id int NOT NULL REFERENCES app.franquia(id) ON DELETE CASCADE,
  module text NOT NULL, active boolean NOT NULL DEFAULT true,
  activated_at timestamptz NOT NULL DEFAULT now(), activated_by text,
  PRIMARY KEY (franquia_id, module));
SQL

echo "[itest] migrations 172 + 173, duas vezes (idempotência)…"
for rodada in 1 2; do
  for m in 172_plataforma_nucleo 173_marketing_nucleo; do
    psql_db < "$ROOT/db/migrations/${m}.sql" >/dev/null
  done
done

echo "[itest] grants de leitura da contratação (duas vezes: idempotência)…"
psql_db < "$ROOT/db/grants/plataforma_contratacao_read.sql"
psql_db < "$ROOT/db/grants/plataforma_contratacao_read.sql"

echo "[itest] conferindo que a RLS está ATIVA e FORÇADA em todas as tabelas novas…"
psql_db <<'SQL'
DO $$
DECLARE r record; faltando text := '';
BEGIN
  FOR r IN
    SELECT n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('plataforma', 'marketing') AND c.relkind = 'r'
  LOOP
    IF NOT r.relrowsecurity OR NOT r.relforcerowsecurity THEN
      faltando := faltando || format('%s.%s ', r.nspname, r.relname);
    END IF;
  END LOOP;
  IF faltando <> '' THEN
    RAISE EXCEPTION 'tabela sem RLS ENABLE+FORCE: %', faltando;
  END IF;
END $$;
SQL

echo "[itest] rodando a suíte de isolamento…"
cd "$ROOT"
DATABASE_URL="postgres://lead_manager_user:itest@127.0.0.1:${PORT}/lm_itest" \
ADMIN_DATABASE_URL="postgres://postgres:itest@127.0.0.1:${PORT}/lm_itest" \
LM_ENCRYPTION_KEY="chave-de-teste-da-infra" \
ISO_TENANT_A="$TENANT_A" ISO_TENANT_B="$TENANT_B" \
node --test --test-concurrency=1 test/isolamento-tenant.itest.js

echo "[itest] ok — isolamento entre unidades provado"
