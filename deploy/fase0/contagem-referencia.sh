#!/usr/bin/env bash
#
# contagem-referencia.sh — ADR-051, Fase 0.
#
# Todo dia: conta as linhas de todas as tabelas (adr_scheduler, evolution, financial_app) e as "impressões digitais"
# de perda que a contagem não vê (anonimização, sobrescrita com vazio). Compara com o dia anterior.
# Só leitura no banco. Escreve em /var/lib/adr-contagem e /var/log/adr-contagem.
#
# ALERTA quando, em adr_scheduler:
#   - uma tabela perde linhas (exceto as de recarga total ou efêmeras listadas em OSCILANTES);
#   - uma impressão digital aumenta.
# evolution e financial_app só são registrados nos primeiros 7 dias (observação), sem alerta.
#
# Reversão: remover a linha do crontab.
#
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PG_CONTAINER="${PG_CONTAINER:-exp44a3i0nnip54f4xc0is0i}"
ENV_FILE="${ENV_FILE:-/root/adr-whatsapp-scheduler/.env}"
DADOS="${DADOS:-/var/lib/adr-contagem}"
LOG_DIR="${LOG_DIR:-/var/log/adr-contagem}"
HOJE="$(date -u +%Y-%m-%d)"

# Tabelas cuja queda é esperada no dia normal (recarga total, filas, caches, sessões). Revisar na Fase 2 (catálogo).
OSCILANTES="${OSCILANTES:-qualidade.aluno_status qualidade.cancelamento_motivo qualidade.aluno_professor resources.resource_availability resources.resource_capability lead_manager.wa_ack_pendente app.sessao app.envio_pendente compasso.documento compasso.certificado lead_manager.pending_approvals}"

mkdir -p "$DADOS" "$LOG_DIR"
DBPW="$(grep '^DB_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"
psqlc() { docker exec -i -e PGPASSWORD="$DBPW" "$PG_CONTAINER" psql -U postgres -q -v ON_ERROR_STOP=1 -At -F $'\t' "$@"; }

ALERTAS="$LOG_DIR/alertas-$HOJE.txt"
: > "$ALERTAS"

for DB in adr_scheduler evolution financial_app; do
  mkdir -p "$DADOS/$DB"
  psqlc -d "$DB" < "$SCRIPT_DIR/contagem.sql" > "$DADOS/$DB/$HOJE.tsv"
done
psqlc -d adr_scheduler < "$SCRIPT_DIR/impressoes.sql" > "$DADOS/adr_scheduler/$HOJE.impressoes.tsv"

ANTERIOR="$(ls "$DADOS/adr_scheduler" | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.tsv$' | sort | grep -v "^$HOJE" | tail -1 || true)"
if [ -z "$ANTERIOR" ]; then
  echo "[$HOJE] primeira contagem gravada (sem comparação)" >> "$LOG_DIR/contagem.log"
  exit 0
fi
DIA_ANT="${ANTERIOR%.tsv}"

# quedas de linhas
awk -F'\t' -v oscil=" $OSCILANTES " '
  FILENAME==ARGV[1] { ant[$1]=$2; next }
  { if (($1 in ant) && $2 < ant[$1] && index(oscil, " " $1 " ") == 0)
      print "QUEDA " $1 ": " ant[$1] " -> " $2 }
' "$DADOS/adr_scheduler/$ANTERIOR" "$DADOS/adr_scheduler/$HOJE.tsv" >> "$ALERTAS"

# tabelas que sumiram
awk -F'\t' 'FILENAME==ARGV[1] { ant[$1]=1; next } { hoje[$1]=1 } END { for (t in ant) if (!(t in hoje)) print "TABELA SUMIU " t }' \
  "$DADOS/adr_scheduler/$ANTERIOR" "$DADOS/adr_scheduler/$HOJE.tsv" >> "$ALERTAS"

# impressões digitais
if [ -f "$DADOS/adr_scheduler/$DIA_ANT.impressoes.tsv" ]; then
  awk -F'\t' 'FILENAME==ARGV[1] { ant[$1]=$2; next } ($1 in ant) && $2 > ant[$1] { print "IMPRESSAO " $1 ": " ant[$1] " -> " $2 }' \
    "$DADOS/adr_scheduler/$DIA_ANT.impressoes.tsv" "$DADOS/adr_scheduler/$HOJE.impressoes.tsv" >> "$ALERTAS"
fi

N="$(wc -l < "$ALERTAS")"
echo "[$HOJE] comparado com $DIA_ANT: $N alerta(s)" >> "$LOG_DIR/contagem.log"
[ "$N" = "0" ] && rm -f "$ALERTAS"
exit 0
