#!/bin/sh
set -eu
: "${RETENTION_DAYS:=7}"
: "${BACKUP_INTERVAL:=86400}"
mkdir -p /backups
while true; do
  ts=$(date +%Y%m%dT%H%M%SZ)
  pg_dump -Fc -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -f "/backups/accounting-$ts.dump"
  echo "backup written: accounting-$ts.dump"
  dump="/backups/accounting-$ts.dump"

  # Encrypt (gated): age recipient + age binary both required, else keep plaintext.
  if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
    if command -v age >/dev/null 2>&1; then
      if age -r "$BACKUP_AGE_RECIPIENT" -o "$dump.age" "$dump"; then
        rm -f "$dump"; dump="$dump.age"; echo "backup encrypted: $(basename "$dump")"
      else
        echo "WARN: age encryption failed — keeping plaintext local dump" >&2; rm -f "$dump.age"
      fi
    else
      echo "WARN: BACKUP_AGE_RECIPIENT set but 'age' not on PATH — unencrypted local dump kept" >&2
    fi
  fi

  # Offsite (gated): S3 (aws or rclone) takes precedence, else rsync. Failures log + continue.
  if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
    if command -v aws >/dev/null 2>&1; then
      aws s3 cp "$dump" "s3://$BACKUP_S3_BUCKET/$(basename "$dump")" && echo "offsite (s3/aws): $(basename "$dump")" || echo "WARN: s3 (aws) upload failed — local dump retained" >&2
    elif command -v rclone >/dev/null 2>&1; then
      rclone copyto "$dump" "$BACKUP_S3_BUCKET/$(basename "$dump")" && echo "offsite (s3/rclone): $(basename "$dump")" || echo "WARN: s3 (rclone) upload failed — local dump retained" >&2
    else
      echo "WARN: BACKUP_S3_BUCKET set but neither 'aws' nor 'rclone' on PATH — local dump only" >&2
    fi
  elif [ -n "${BACKUP_RSYNC_TARGET:-}" ]; then
    if command -v rsync >/dev/null 2>&1; then
      rsync -a "$dump" "$BACKUP_RSYNC_TARGET" && echo "offsite (rsync): $(basename "$dump")" || echo "WARN: rsync upload failed — local dump retained" >&2
    else
      echo "WARN: BACKUP_RSYNC_TARGET set but 'rsync' not on PATH — local dump only" >&2
    fi
  fi

  mkdir -p /backup-metrics
  printf 'backup_last_success_timestamp_seconds %s\n' "$(date +%s)" > /backup-metrics/backup.prom.tmp
  mv /backup-metrics/backup.prom.tmp /backup-metrics/backup.prom
  find /backups -name 'accounting-*.dump*' -mtime +"$RETENTION_DAYS" -delete
  sleep "$BACKUP_INTERVAL"
done
