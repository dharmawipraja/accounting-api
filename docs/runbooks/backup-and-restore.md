# Backup & Restore Runbook

## What is backed up
A logical `pg_dump -Fc` (custom format) of the `accounting` database, written by
the `backup` sidecar to the `backups` Docker volume every `BACKUP_INTERVAL`
seconds (default 86400 = daily). Dumps older than `RETENTION_DAYS` (default 7)
are pruned automatically. Files are named `accounting-<UTC-timestamp>.dump`.

## Where the dumps live
The `backups` named volume (inspect: `docker volume inspect accounting-api_backups`).
Copy a dump to the host: `docker compose -f docker-compose.yml -f docker-compose.prod.yml cp backup:/backups/<file> ./`.

## Restore
1. Stop writers: `docker compose -f docker-compose.yml -f docker-compose.prod.yml stop api migrate`.
2. Restore (drops & recreates objects from the dump):
   `docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T db \
     pg_restore --clean --if-exists --no-owner -U accounting -d accounting < /backups/<file>`
   (run from inside the backup/db container or pipe a host copy in).
3. Re-apply any newer migrations (no-op if the dump is current): bring `migrate` up.
4. Start the app: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`.

## Test your restore (do this periodically)
Restore the latest dump into a scratch database and spot-check row counts:
`createdb scratch && pg_restore -d scratch <file> && psql scratch -c 'SELECT count(*) FROM journal_entries;'`.
A backup you have never restored is not a backup.
