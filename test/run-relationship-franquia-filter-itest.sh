#!/usr/bin/env bash
# run-relationship-franquia-filter-itest.sh — prova do filtro de franquia em _isRelationshipContact.
# Sobe Postgres DESCARTÁVEL, cria app.professor_notificacao com 3 cenários (Valinhos/Cambuí/dual)
# e roda a itest. NUNCA toca produção. Cadastro guarda telefone SEM 55 (como a base real).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${ITEST_PG_PORT:-55435}"
CTR="lm-relfranq-itest-pg"

cleanup() { docker rm -f "$CTR" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "[itest] subindo Postgres efêmero ($CTR) na porta $PORT…"
docker run --rm -d --name "$CTR" -e POSTGRES_PASSWORD=itest -p "127.0.0.1:${PORT}:5432" postgres:16-alpine >/dev/null
echo "[itest] aguardando readiness…"
for i in $(seq 1 30); do docker exec "$CTR" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done

echo "[itest] schema app.professor_notificacao + fixtures (tel SEM 55)…"
docker exec -i "$CTR" psql -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<SQL
CREATE SCHEMA app;
CREATE TABLE app.professor_notificacao (
  franquia_id       int  NOT NULL,
  professor_id      text NOT NULL,
  nome              text,
  telefone          text,
  telefone_override text
);
INSERT INTO app.professor_notificacao (franquia_id, professor_id, nome, telefone) VALUES
  (1, '17', 'Valinhos One', '19994301015'),   -- só Valinhos
  (5, '99', 'Cambui Only',  '19955556666'),   -- só Cambuí (não deve casar)
  (1, '58', 'Dual Unidade', '19977778888'),   -- dual: linha franquia 1
  (5, '58', 'Dual Unidade', '19977778888');   -- dual: linha franquia 5
SQL

echo "[itest] rodando node --test…"
cd "$ROOT"
DATABASE_URL="postgres://postgres:itest@127.0.0.1:${PORT}/postgres" \
node --test test/relationship-franquia-filter.itest.js
