#!/usr/bin/env bash
#
# backup-v2.sh — ADR-051, Fase 0 (janela J0-A).
#
# Backup COMPLETO e CIFRADO, rodando AO LADO do /root/backups/backup.sh antigo (que não é tocado).
# O que entra (tudo dentro de um repositório restic, cifrado com a senha de /root/.adr-backup/restic.pass):
#   - roles e configurações do cluster (pg_dumpall --globals-only) + configurações por banco/role
#   - bancos adr_scheduler, evolution e financial_app (pg_dump -Fc), com contagem de linhas antes e depois
#   - mídias do Lead Manager (/apps/lead-manager/uploads)
#   - /data do dashboard (/root/adr-whatsapp-scheduler/.extranet-session: fotos, sessão)
#   - volume evolution-instances (sessões do WhatsApp)
# O que NÃO entra, de propósito: arquivos .env e chaves de criptografia (guarda separada, com o Leo).
#
# Cópia fora da VPS: se /root/.adr-backup/b2.env existir, o repositório local é copiado para o Backblaze B2.
#
# Reversão: remover a linha do crontab. Nada em produção é alterado por este script
# (só leitura no banco; escrita apenas em /var/backups/adr-v2 e /var/log/adr-backup-v2).
#
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PG_CONTAINER="${PG_CONTAINER:-exp44a3i0nnip54f4xc0is0i}"
ENV_FILE="${ENV_FILE:-/root/adr-whatsapp-scheduler/.env}"
BASE="${BASE:-/var/backups/adr-v2}"
CONF="${CONF:-/root/.adr-backup}"
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:0.17.3}"
DATABASES="${DATABASES:-adr_scheduler evolution financial_app}"
UPLOADS_LM="${UPLOADS_LM:-/apps/lead-manager/uploads}"
DASH_DATA="${DASH_DATA:-/root/adr-whatsapp-scheduler/.extranet-session}"
EVO_INSTANCES="${EVO_INSTANCES:-/var/lib/docker/volumes/z11029bsysj7s8sndunmyauk_evolution-instances/_data}"
LOG_DIR="${LOG_DIR:-/var/log/adr-backup-v2}"
MIN_LIVRE_GB="${MIN_LIVRE_GB:-20}"

ts()    { date -u +%Y-%m-%dT%H:%M:%SZ; }
log()   { echo "[$(ts)] $*"; }
status(){ printf '{"quando":"%s","ok":%s,"detalhe":"%s","b2":"%s"}\n' "$(ts)" "$1" "$2" "${B2_STATUS:-nao_configurado}" > "$LOG_DIR/ultimo.json"; }
falha() { log "FALHA: $*"; status false "$*"; exit 1; }

mkdir -p "$LOG_DIR" "$BASE"
exec 9>"$BASE/.lock"
flock -n 9 || { log "outra execução em andamento; saindo"; exit 0; }

# ---------- pré-checagens ----------
[ "$(id -u)" = "0" ] || falha "precisa rodar como root"
[ -s "$CONF/restic.pass" ] || falha "senha do repositório ausente ($CONF/restic.pass)"
for p in "$UPLOADS_LM" "$DASH_DATA" "$EVO_INSTANCES"; do [ -d "$p" ] || falha "diretório ausente: $p"; done
DBPW="$(grep '^DB_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"
[ -n "$DBPW" ] || falha "DB_PASSWORD não encontrado em $ENV_FILE"
LIVRE_GB="$(df -BG --output=avail "$BASE" | tail -1 | tr -dc 0-9)"
[ "$LIVRE_GB" -ge "$MIN_LIVRE_GB" ] || falha "espaço livre insuficiente: ${LIVRE_GB} GB"

psqlc() { docker exec -i -e PGPASSWORD="$DBPW" "$PG_CONTAINER" psql -U postgres -q -v ON_ERROR_STOP=1 -At -F $'\t' "$@"; }

CONCORRENTES="$(psqlc -d postgres -c "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'pg_dump' AND pid <> pg_backend_pid()")"
[ "$CONCORRENTES" = "0" ] || falha "há pg_dump em andamento (backup antigo?); tente mais tarde"

STAGE="$BASE/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

# ---------- banco ----------
log "globals (roles) e configurações por banco/role"
docker exec -e PGPASSWORD="$DBPW" "$PG_CONTAINER" pg_dumpall -U postgres --globals-only > "$STAGE/globals.sql" \
  || falha "pg_dumpall --globals-only"
psqlc -d postgres -c "SELECT COALESCE(d.datname, ''), COALESCE(r.rolname, ''), unnest(s.setconfig)
                        FROM pg_db_role_setting s
                   LEFT JOIN pg_database d ON d.oid = s.setdatabase
                   LEFT JOIN pg_roles r ON r.oid = s.setrole" > "$STAGE/db-role-settings.tsv" \
  || falha "configurações por banco/role"

for DB in $DATABASES; do
  log "contagem antes: $DB"
  psqlc -d "$DB" < "$SCRIPT_DIR/contagem.sql" > "$STAGE/$DB.contagem-antes.tsv" || falha "contagem antes $DB"
  log "dump: $DB"
  docker exec -e PGPASSWORD="$DBPW" "$PG_CONTAINER" pg_dump -U postgres -Fc "$DB" > "$STAGE/$DB.dump" \
    || falha "pg_dump $DB"
  [ "$(stat -c%s "$STAGE/$DB.dump")" -gt 10240 ] || falha "dump pequeno demais: $DB"
  log "contagem depois: $DB"
  psqlc -d "$DB" < "$SCRIPT_DIR/contagem.sql" > "$STAGE/$DB.contagem-depois.tsv" || falha "contagem depois $DB"
done
( cd "$STAGE" && sha256sum ./*.dump ./globals.sql > SHA256SUMS )

# ---------- restic local ----------
restic_local() {
  docker run --rm --hostname adr-vps \
    -e RESTIC_PASSWORD_FILE=/conf/restic.pass \
    -v "$CONF:/conf:ro" \
    -v "$BASE/restic-local:/repo" \
    -v "$STAGE:/src/banco:ro" \
    -v "$UPLOADS_LM:/src/lm-uploads:ro" \
    -v "$DASH_DATA:/src/dashboard-data:ro" \
    -v "$EVO_INSTANCES:/src/evolution-instances:ro" \
    "$RESTIC_IMAGE" -r /repo "$@"
}
mkdir -p "$BASE/restic-local"
if [ ! -f "$BASE/restic-local/config" ]; then
  log "iniciando repositório local"
  restic_local init || falha "restic init local"
fi
log "enviando ao repositório local"
restic_local backup --tag adr-v2 /src || falha "restic backup local"
RETENCAO=(--tag adr-v2 --keep-daily 14 --keep-weekly 8 --keep-monthly 12)
if [ "$(date -u +%u)" = "7" ]; then
  restic_local forget "${RETENCAO[@]}" --prune || falha "restic forget/prune local"
  restic_local check || falha "restic check local"
else
  restic_local forget "${RETENCAO[@]}" || falha "restic forget local"
fi

# ---------- cópia fora da VPS (Backblaze B2) ----------
B2_STATUS="nao_configurado"
if [ -s "$CONF/b2.env" ]; then
  restic_b2() {
    docker run --rm --hostname adr-vps \
      --env-file "$CONF/b2.env" \
      -e RESTIC_PASSWORD_FILE=/conf/restic.pass \
      -v "$CONF:/conf:ro" \
      -v "$BASE/restic-local:/repo" \
      "$RESTIC_IMAGE" "$@"
  }
  if ! restic_b2 cat config > /dev/null 2>&1; then
    log "iniciando repositório no B2"
    restic_b2 init --from-repo /repo --from-password-file /conf/restic.pass --copy-chunker-params \
      || { B2_STATUS="falhou_init"; falha "restic init B2"; }
  fi
  log "copiando para o B2"
  restic_b2 copy --from-repo /repo --from-password-file /conf/restic.pass --tag adr-v2 \
    || { B2_STATUS="falhou_copia"; falha "restic copy B2"; }
  restic_b2 forget "${RETENCAO[@]}" $( [ "$(date -u +%u)" = "7" ] && echo --prune ) \
    || { B2_STATUS="falhou_forget"; falha "restic forget B2"; }
  B2_STATUS="ok"
fi

TAM_DUMPS="$(du -sh "$STAGE" | cut -f1)"
log "backup completo (dumps: $TAM_DUMPS, B2: $B2_STATUS)"
status true "dumps $TAM_DUMPS"
