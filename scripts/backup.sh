#!/bin/sh
set -eu
: "${RETENTION_DAYS:=7}"
: "${BACKUP_INTERVAL:=86400}"
mkdir -p /backups
while true; do
  ts=$(date +%Y%m%dT%H%M%SZ)
  pg_dump -Fc -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -f "/backups/accounting-$ts.dump"
  echo "backup written: accounting-$ts.dump"
  mkdir -p /backup-metrics
  printf 'backup_last_success_timestamp_seconds %s\n' "$(date +%s)" > /backup-metrics/backup.prom.tmp
  mv /backup-metrics/backup.prom.tmp /backup-metrics/backup.prom
  find /backups -name 'accounting-*.dump' -mtime +"$RETENTION_DAYS" -delete
  sleep "$BACKUP_INTERVAL"
done
