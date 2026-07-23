#!/usr/bin/env bash
# run-lifecycle-canonico-itest.sh — itest da Fatia A (régua canônica lead ativo/convertido).
# PG DESCARTÁVEL. NUNCA toca produção.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${ITEST_PG_PORT:-55445}"
CTR="lm-lifecycle-itest-pg"
cleanup() { docker rm -f "$CTR" >/dev/null 2>&1 || true; }
trap cleanup EXIT; cleanup
echo "[itest] Postgres efêmero ($CTR):$PORT…"
docker run --rm -d --name "$CTR" -e POSTGRES_PASSWORD=itest -p "127.0.0.1:${PORT}:5432" postgres:16-alpine >/dev/null
for i in $(seq 1 60); do docker exec "$CTR" psql -U postgres -d postgres -tAc 'SELECT 1' >/dev/null 2>&1 && { sleep 1; break; }; sleep 1; done
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c "CREATE DATABASE lm_itest;" >/dev/null
echo "[itest] node --test…"
cd "$ROOT"
DATABASE_URL="postgres://postgres:itest@127.0.0.1:${PORT}/lm_itest" \
node --test test/lifecycle-canonico.itest.js
