#!/usr/bin/env bash
# run-pending-cleanup-itest.sh — itest da Fatia D (dedup Portão 2 + limpeza 074).
# PG DESCARTÁVEL, schema lead_manager. NUNCA toca produção.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${ITEST_PG_PORT:-55446}"
CTR="lm-pending-itest-pg"
cleanup() { docker rm -f "$CTR" >/dev/null 2>&1 || true; }
trap cleanup EXIT; cleanup
echo "[itest] Postgres efêmero ($CTR):$PORT…"
docker run --rm -d --name "$CTR" -e POSTGRES_PASSWORD=itest -p "127.0.0.1:${PORT}:5432" postgres:16-alpine >/dev/null
for i in $(seq 1 60); do docker exec "$CTR" psql -U postgres -d postgres -tAc 'SELECT 1' >/dev/null 2>&1 && { sleep 1; break; }; sleep 1; done
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "CREATE DATABASE lm_itest;" >/dev/null
echo "[itest] node --test…"
cd "$ROOT"
DATABASE_URL="postgres://postgres:itest@127.0.0.1:${PORT}/lm_itest" \
node --test test/pending-cleanup.itest.js
