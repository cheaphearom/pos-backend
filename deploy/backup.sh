#!/bin/sh
# Runs in the stock postgres image (the script is mounted in). The copy to Cloudflare R2 is done by the
# separate backup-r2 service (rclone).
# Usage: backup.sh once   -> one backup now
#        backup.sh loop   -> every day at BACKUP_TIME (default 03:30, server time zone TZ)
#        backup.sh restore <file.sql.gz>  -> replace the database with a backup (asks no questions!)
set -eu
export PGPASSWORD="$POSTGRES_PASSWORD"
DIR=/backups
KEEP="${BACKUP_KEEP_DAYS:-14}"
AT="${BACKUP_TIME:-03:30}"

one() {
  f="$DIR/pos-$(date +%Y%m%d-%H%M%S).sql.gz"
  pg_dump -h postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner | gzip -9 > "$f.part"
  mv "$f.part" "$f"
  echo "[backup] saved $f ($(du -h "$f" | cut -f1))"
  find "$DIR" -name 'pos-*.sql.gz' -mtime +"$KEEP" -delete
}

case "${1:-loop}" in
  once) one ;;
  restore)
    [ -f "${2:-}" ] || { echo "backup file not found: ${2:-}"; exit 1; }
    psql -h postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
    gunzip -c "$2" | psql -h postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q
    echo "[backup] restored $2" ;;
  loop)
    echo "[backup] daily at $AT, keeping $KEEP days"
    while true; do
      now=$(date +%H:%M)
      if [ "$now" = "$AT" ]; then one || echo "[backup] FAILED"; sleep 61; fi
      sleep 30
    done ;;
esac
