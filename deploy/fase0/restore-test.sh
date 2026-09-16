#!/usr/bin/env bash
#
# restore-test.sh — ADR-051, Fase 0 (T-RESTORE-01).
#
# Restaura o último snapshot do backup-v2 num Postgres DESCARTÁVEL e ISOLADO (rede docker interna, sem saída),
# e prova que o backup serve:
#   1. todos os bancos restauram sem erro;
#   2. a contagem de linhas de cada tabela restaurada fica entre a contagem de antes e a de depois do dump;
#   3. as configurações por banco/role (jit, work_mem, search_path) voltam;
#   4. certificado digital, credencial da Extranet e token do WhatsApp abrem com as chaves atuais;
#   5. uma amostra de 50 mídias restauradas é idêntica (sha256) às do disco.
#
# NUNCA toca o Postgres de produção: o container de teste tem outro nome e é conferido antes.
# Ao sair (sucesso, falha ou interrupção), apaga o container, a rede e os arquivos restaurados (que têm dado real).
#
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROD_PG="${PROD_PG:-exp44a3i0nnip54f4xc0is0i}"
TEST_PG="adr-restore-teste"
NET="adr-restore-net"
BASE="${BASE:-/var/backups/adr-v2}"
CONF="${CONF:-/root/.adr-backup}"
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:0.17.3}"
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
CHECK_IMAGE="${CHECK_IMAGE:-adr-dashboard:latest}"
DATABASES="${DATABASES:-adr_scheduler evolution financial_app}"
UPLOADS_LM="${UPLOADS_LM:-/apps/lead-manager/uploads}"
APP_ENV_FILE="${APP_ENV_FILE:-/root/adr-whatsapp-scheduler/.env}"
LM_ENV_FILE="${LM_ENV_FILE:-/apps/lead-manager/.env.claude-code}"
WORK="$BASE/restore-teste"
RELATORIO="${RELATORIO:-/var/log/adr-backup-v2/restore-teste-$(date -u +%Y%m%dT%H%M%SZ).txt}"

ts()  { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" | tee -a "$RELATORIO"; }
FALHAS=0
reprova() { log "REPROVADO: $*"; FALHAS=$((FALHAS + 1)); }

[ "$TEST_PG" != "$PROD_PG" ] || { echo "container de teste igual ao de produção; abortando"; exit 99; }
[ "$(id -u)" = "0" ] || { echo "precisa rodar como root"; exit 1; }
mkdir -p "$(dirname "$RELATORIO")"

limpar() {
  docker rm -f "$TEST_PG" > /dev/null 2>&1 || true
  docker network rm "$NET" > /dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap limpar EXIT
limpar
mkdir -p "$WORK"

restic_local() {
  docker run --rm --hostname adr-vps \
    -e RESTIC_PASSWORD_FILE=/conf/restic.pass \
    -v "$CONF:/conf:ro" -v "$BASE/restic-local:/repo" -v "$WORK:/work" \
    "$RESTIC_IMAGE" -r /repo "$@"
}

# ---------- 1. restaurar arquivos ----------
log "restaurando o banco do último snapshot"
restic_local restore latest --tag adr-v2 --target /work --include /src/banco > /dev/null
STAGE="$WORK/src/banco"
[ -s "$STAGE/globals.sql" ] || { log "snapshot sem globals.sql"; exit 1; }
( cd "$STAGE" && sha256sum -c --quiet SHA256SUMS ) || reprova "checksums dos dumps não conferem"

log "restaurando amostra de 50 mídias"
( cd "$UPLOADS_LM" && find . -type f -mmin +1440 | shuf -n 50 ) > "$WORK/amostra.txt" || true
sed 's#^\./#/src/lm-uploads/#' "$WORK/amostra.txt" > "$WORK/amostra-include.txt"
if [ -s "$WORK/amostra-include.txt" ]; then
  restic_local restore latest --tag adr-v2 --target /work --include-file /work/amostra-include.txt > /dev/null
  DIF=0
  while IFS= read -r rel; do
    a="$(sha256sum "$UPLOADS_LM/${rel#./}" | cut -d' ' -f1)"
    b="$(sha256sum "$WORK/src/lm-uploads/${rel#./}" 2>/dev/null | cut -d' ' -f1 || true)"
    [ "$a" = "$b" ] || DIF=$((DIF + 1))
  done < "$WORK/amostra.txt"
  [ "$DIF" = "0" ] && log "mídias: 50/50 idênticas" || reprova "mídias diferentes na amostra: $DIF"
fi

# ---------- 2. Postgres isolado ----------
log "subindo Postgres de teste isolado"
docker network create --internal "$NET" > /dev/null
PW="$(openssl rand -hex 16)"
docker run -d --name "$TEST_PG" --network "$NET" --cpus 1 --memory 1g \
  -e POSTGRES_PASSWORD="$PW" -v "$STAGE:/restore:ro" "$PG_IMAGE" > /dev/null
for _ in $(seq 1 60); do docker exec "$TEST_PG" pg_isready -U postgres > /dev/null 2>&1 && break; sleep 2; done
docker exec "$TEST_PG" pg_isready -U postgres > /dev/null || { log "Postgres de teste não subiu"; exit 1; }

tpsql() { docker exec -i "$TEST_PG" psql -U postgres -q -At -F $'\t' "$@"; }

log "restaurando roles"
tpsql -d postgres -f /restore/globals.sql > "$WORK/globals.log" 2>&1 || true
ERR_GLOBALS="$(grep -c 'ERROR' "$WORK/globals.log" || true)"
ESPERADOS="$(grep -c 'role "postgres" already exists' "$WORK/globals.log" || true)"
[ "$ERR_GLOBALS" = "$ESPERADOS" ] || reprova "erros inesperados ao restaurar roles: $((ERR_GLOBALS - ESPERADOS))"

for DB in $DATABASES; do
  log "restaurando banco $DB"
  tpsql -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB\"" > /dev/null
  if ! docker exec "$TEST_PG" pg_restore -U postgres -d "$DB" "/restore/$DB.dump" > "$WORK/$DB.restore.log" 2>&1; then
    reprova "pg_restore de $DB terminou com erros: $(grep -c 'error' "$WORK/$DB.restore.log" || true)"
  fi
done

# ---------- 3. configurações por banco/role ----------
# Só entram na comparação as configurações globais de role e as dos bancos que fazem parte do backup.
# pg_dumpall --globals-only traz ALTER ROLE ... SET; as de banco e de role-no-banco são reaplicadas aqui.
filtrar_settings() { awk -F'\t' -v dbs=" $DATABASES " '$1 == "" || index(dbs, " " $1 " ") > 0' | sort; }
filtrar_settings < "$STAGE/db-role-settings.tsv" > "$WORK/settings-origem.tsv"
while IFS=$'\t' read -r db role cfg; do
  [ -n "$cfg" ] && [ -n "$db" ] || continue
  if [ -z "$role" ]; then
    sql="ALTER DATABASE \"$db\" SET ${cfg%%=*} = ${cfg#*=}"
  else
    sql="ALTER ROLE \"$role\" IN DATABASE \"$db\" SET ${cfg%%=*} = ${cfg#*=}"
  fi
  tpsql -d postgres -c "$sql" > /dev/null 2>&1 || reprova "não reaplicou configuração ($db/$role): ${cfg%%=*}"
done < "$WORK/settings-origem.tsv"
tpsql -d postgres -c "SELECT COALESCE(d.datname, ''), COALESCE(r.rolname, ''), unnest(s.setconfig)
                        FROM pg_db_role_setting s
                   LEFT JOIN pg_database d ON d.oid = s.setdatabase
                   LEFT JOIN pg_roles r ON r.oid = s.setrole" | filtrar_settings > "$WORK/settings-restaurado.tsv"
if diff -q "$WORK/settings-origem.tsv" "$WORK/settings-restaurado.tsv" > /dev/null; then
  log "configurações por banco/role: idênticas ($(wc -l < "$WORK/settings-origem.tsv"))"
else
  reprova "configurações por banco/role diferentes: $(diff "$WORK/settings-origem.tsv" "$WORK/settings-restaurado.tsv" | grep -c '^[<>]')"
fi

# ---------- 4. contagem ----------
for DB in $DATABASES; do
  tpsql -d "$DB" < "$SCRIPT_DIR/contagem.sql" > "$WORK/$DB.contagem-restaurado.tsv"
  RUINS="$(awk -F'\t' '
    FILENAME==ARGV[1] { antes[$1]=$2; next }
    FILENAME==ARGV[2] { depois[$1]=$2; next }
    { r[$1]=$2 }
    END {
      n=0
      for (t in antes) {
        lo = antes[t] < depois[t] ? antes[t] : depois[t]
        hi = antes[t] > depois[t] ? antes[t] : depois[t]
        if (!(t in r) || r[t] < lo || r[t] > hi) { print t " antes=" antes[t] " depois=" depois[t] " restaurado=" (t in r ? r[t] : "ausente"); n++ }
      }
      exit (n > 0)
    }' "$STAGE/$DB.contagem-antes.tsv" "$STAGE/$DB.contagem-depois.tsv" "$WORK/$DB.contagem-restaurado.tsv")" \
    && log "contagem $DB: todas as $(wc -l < "$STAGE/$DB.contagem-antes.tsv") tabelas conferem" \
    || { echo "$RUINS" >> "$RELATORIO"; reprova "contagem $DB: tabelas fora do intervalo (lista acima)"; }
done

# ---------- 5. segredos cifrados ----------
log "conferindo que os segredos cifrados abrem com as chaves atuais"
APP_KEY="$(grep '^APP_ENCRYPTION_KEY=' "$APP_ENV_FILE" | cut -d= -f2-)"
LM_KEY="$(grep '^LM_ENCRYPTION_KEY=' "$LM_ENV_FILE" | cut -d= -f2-)"
if [ -z "$APP_KEY" ] || [ -z "$LM_KEY" ]; then
  reprova "chaves de criptografia não encontradas nos arquivos de ambiente"
else
  if SAIDA="$(docker run --rm --network "$NET" --entrypoint node \
        -e APP_ENCRYPTION_KEY="$APP_KEY" -e LM_ENCRYPTION_KEY="$LM_KEY" \
        -e RESTORE_DATABASE_URL="postgres://postgres:${PW}@${TEST_PG}:5432/adr_scheduler" \
        -e NODE_PATH=/app/node_modules \
        -v "$SCRIPT_DIR/verifica-cifra.js:/tmp/verifica-cifra.js:ro" \
        "$CHECK_IMAGE" /tmp/verifica-cifra.js 2>&1)"; then
    log "segredos: $SAIDA"
  else
    reprova "segredos: $SAIDA"
  fi
fi
unset APP_KEY LM_KEY

# ---------- resultado ----------
if [ "$FALHAS" = "0" ]; then
  log "RESULTADO: APROVADO"
  exit 0
fi
log "RESULTADO: REPROVADO ($FALHAS verificações falharam)"
exit 1
