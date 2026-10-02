#!/bin/sh
set -eu
: "${RETENTION_DAYS:=7}"
: "${BACKUP_INTERVAL:=86400}"
# Container paths (docker-compose.prod.yml volumes); overridable for tests only.
: "${BACKUP_DIR:=/backups}"
: "${BACKUP_METRICS_DIR:=/backup-metrics}"

# Validate BEFORE doing any work. A bad value (non-numeric, quoted "30", 0)
# would otherwise make `find -mtime` / `sleep` fail AFTER pg_dump under set -e,
# and `restart: unless-stopped` would re-run pg_dump on every restart (disk
# fills, nothing is pruned). On invalid config: no dump, exit 64 (EX_USAGE).
# The 60s pause before exiting keeps the restart loop to ~1/min with a
# readable log (the container then counts as "ran >10s", so Docker keeps a
# steady cadence instead of a burst of fast restarts); the loop does no work.
invalid_config() {
  echo "backup: $1 — refusing to run (no dump taken); fix .env and recreate the backup service" >&2
  sleep 60
  exit 64
}
case "$RETENTION_DAYS" in
  ''|*[!0-9]*) invalid_config "RETENTION_DAYS must be a bare positive integer (days), got '$RETENTION_DAYS'" ;;
esac
[ "$RETENTION_DAYS" -ge 1 ] || invalid_config "RETENTION_DAYS must be >= 1, got '$RETENTION_DAYS'"
case "$BACKUP_INTERVAL" in
  ''|*[!0-9]*) invalid_config "BACKUP_INTERVAL must be a bare positive integer (seconds), got '$BACKUP_INTERVAL'" ;;
esac
[ "$BACKUP_INTERVAL" -ge 60 ] || invalid_config "BACKUP_INTERVAL must be >= 60 seconds, got '$BACKUP_INTERVAL'"

mkdir -p "$BACKUP_DIR"
# A `*.dump.tmp` / `*.dump.age.tmp` is an interrupted dump / encryption from an
# earlier run (container killed mid-pg_dump / mid-age): never a restorable
# backup. One sidecar, so none is in progress.
find "$BACKUP_DIR" \( -name 'accounting-*.dump.tmp' -o -name 'accounting-*.dump.age.tmp' \) -delete
while true; do
  ts=$(date +%Y%m%dT%H%M%SZ)
  dump="$BACKUP_DIR/accounting-$ts.dump"
  # Dump to <name>.tmp and rename only on success (atomic on one filesystem):
  # an interrupted or failed dump never looks like the newest backup.
  if ! pg_dump -Fc -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -f "$dump.tmp"; then
    rm -f "$dump.tmp"
    echo "backup: pg_dump failed — no backup written" >&2
    exit 1
  fi
  mv "$dump.tmp" "$dump"
  echo "backup written: accounting-$ts.dump"

  # Encrypt (gated): age recipient + age binary both required, else keep plaintext.
  # With a recipient configured, a dump that did NOT get encrypted this run (age
  # failed or missing) stays local-only: it is never shipped offsite (the
  # contract is "encrypted before leaving the host"); retention prunes it. Each
  # run decides afresh, so the next successful encryption ships normally.
  # A plaintext `.dump` left by such a run is never re-encrypted or shipped
  # later — it stays local-only until retention removes it.
  ship=1
  shipped=0   # set to 1 only by a successful offsite upload below
  if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
    ship=0
    if command -v age >/dev/null 2>&1; then
      # Same tmp+rename as the dump: an interrupted/failed age run never leaves a
      # truncated `.dump.age` that looks like a complete encrypted backup.
      if age -r "$BACKUP_AGE_RECIPIENT" -o "$dump.age.tmp" "$dump"; then
        mv "$dump.age.tmp" "$dump.age"
        rm -f "$dump"; dump="$dump.age"; ship=1; echo "backup encrypted: $(basename "$dump")"
      else
        echo "WARN: age encryption failed — keeping plaintext local dump" >&2; rm -f "$dump.age.tmp"
      fi
    else
      echo "WARN: BACKUP_AGE_RECIPIENT set but 'age' not on PATH — unencrypted local dump kept" >&2
    fi
  fi

  # Offsite (gated): S3 (aws or rclone) takes precedence, else rsync. Failures log + continue.
  if [ "$ship" -eq 0 ]; then
    if [ -n "${BACKUP_S3_BUCKET:-}" ] || [ -n "${BACKUP_RSYNC_TARGET:-}" ]; then
      echo "WARN: $(basename "$dump") not shipped offsite: encryption failed (BACKUP_AGE_RECIPIENT set) — local plaintext only" >&2
    fi
  elif [ -n "${BACKUP_S3_BUCKET:-}" ]; then
    if command -v aws >/dev/null 2>&1; then
      aws s3 cp "$dump" "s3://$BACKUP_S3_BUCKET/$(basename "$dump")" && shipped=1 && echo "offsite (s3/aws): $(basename "$dump")" || echo "WARN: s3 (aws) upload failed — local dump retained" >&2
    elif command -v rclone >/dev/null 2>&1; then
      rclone copyto "$dump" "$BACKUP_S3_BUCKET/$(basename "$dump")" && shipped=1 && echo "offsite (s3/rclone): $(basename "$dump")" || echo "WARN: s3 (rclone) upload failed — local dump retained" >&2
    else
      echo "WARN: BACKUP_S3_BUCKET set but neither 'aws' nor 'rclone' on PATH — local dump only" >&2
    fi
  elif [ -n "${BACKUP_RSYNC_TARGET:-}" ]; then
    if command -v rsync >/dev/null 2>&1; then
      rsync -a "$dump" "$BACKUP_RSYNC_TARGET" && shipped=1 && echo "offsite (rsync): $(basename "$dump")" || echo "WARN: rsync upload failed — local dump retained" >&2
    else
      echo "WARN: BACKUP_RSYNC_TARGET set but 'rsync' not on PATH — local dump only" >&2
    fi
  fi

  # Metrics: the local dump and the offsite copy are tracked SEPARATELY, so a
  # failing upload (expired credentials, age missing) alerts instead of being
  # hidden behind a fresh local dump (OffsiteBackupStale in monitoring/alerts.yml).
  mkdir -p "$BACKUP_METRICS_DIR"
  now=$(date +%s)
  offsite_configured=0
  if [ -n "${BACKUP_S3_BUCKET:-}" ] || [ -n "${BACKUP_RSYNC_TARGET:-}" ]; then offsite_configured=1; fi
  [ "$shipped" -eq 1 ] && echo "$now" > "$BACKUP_METRICS_DIR/offsite.last"
  offsite_last=$(cat "$BACKUP_METRICS_DIR/offsite.last" 2>/dev/null || echo 0)
  {
    printf 'backup_last_success_timestamp_seconds %s\n' "$now"
    printf 'backup_offsite_configured %s\n' "$offsite_configured"
    printf 'backup_last_offsite_success_timestamp_seconds %s\n' "$offsite_last"
  } > "$BACKUP_METRICS_DIR/backup.prom.tmp"
  mv "$BACKUP_METRICS_DIR/backup.prom.tmp" "$BACKUP_METRICS_DIR/backup.prom"
  find "$BACKUP_DIR" -name 'accounting-*.dump*' -mtime +"$RETENTION_DAYS" -delete
  sleep "$BACKUP_INTERVAL"
done
