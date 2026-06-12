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
Run `pg_restore` **from inside the `backup` sidecar** — it is the only container
that mounts the `backups` volume, it has the Postgres client tools, and its
`PGPASSWORD`/`PGUSER`/`PGDATABASE` env let it reach `db` over the compose network.
(`COMPOSE='-f docker-compose.yml -f docker-compose.prod.yml'`.)

1. Stop writers: `docker compose $COMPOSE stop api migrate`.
2. Restore (drops & recreates objects from the dump; `db` and `backup` stay up):
   `docker compose $COMPOSE exec backup \
     pg_restore --clean --if-exists --no-owner -h db -U accounting -d accounting /backups/<file>`
   (the dump path is a positional arg — custom-format dumps are not read from stdin).
3. Re-apply any newer migrations (no-op if the dump is current): `docker compose $COMPOSE up -d migrate`.
4. Start the app: `docker compose $COMPOSE up -d`.

## Test your restore (do this periodically)
Restore the latest dump into a scratch database **inside the sidecar** and
spot-check row counts (a backup you have never restored is not a backup):
```sh
COMPOSE='-f docker-compose.yml -f docker-compose.prod.yml'
docker compose $COMPOSE exec backup sh -c '
  createdb -h db -U accounting scratch &&
  pg_restore --no-owner -h db -U accounting -d scratch /backups/<file> &&
  psql -h db -U accounting -d scratch -c "SELECT count(*) FROM journal_entries;" &&
  dropdb -h db -U accounting scratch'
```
