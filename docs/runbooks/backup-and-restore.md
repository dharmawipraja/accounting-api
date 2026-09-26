# Backup & Restore Runbook

## What is backed up
A logical `pg_dump -Fc` (custom format) of the `accounting` database, written by
the `backup` sidecar to the `backups` Docker volume every `BACKUP_INTERVAL`
seconds (default 86400 = daily). Dumps older than `RETENTION_DAYS` (default 7)
are pruned automatically. Both are read from the VM's `.env`
(`docker-compose.prod.yml` passes `${RETENTION_DAYS:-7}` / `${BACKUP_INTERVAL:-86400}`;
bare integers only — `RETENTION_DAYS` ≥ 1, `BACKUP_INTERVAL` ≥ 60 — otherwise
`scripts/backup.sh` logs the problem and exits 64 **before** `pg_dump`, so a
restart loop never fills the disk);
after changing them recreate only the sidecar:
`docker compose $COMPOSE up -d --no-build --no-deps backup` (`$COMPOSE` as in *Restore*). Files are named `accounting-<UTC-timestamp>.dump`.

## Where the dumps live
The `backups` named volume (inspect: `docker volume inspect accounting-api_backups`).
Copy a dump to the host: `docker compose -f docker-compose.yml -f docker-compose.prod.yml cp backup:/backups/<file> ./`.

## Restore
Run `pg_restore` **from inside the `backup` sidecar** — it is the only container
that mounts the `backups` volume, it has the Postgres client tools, and its
`PGPASSWORD`/`PGUSER`/`PGDATABASE` env let it reach `db` over the compose network.
In production `db` is **not published on the host** (only Caddy is), so a host-side
`psql`/`pg_restore` against `127.0.0.1:5432` fails by design — stay inside the
containers, or add the opt-in `-f docker-compose.hostport.yml` for a one-off
(see `deploy.md` → *Health & shutdown*).
(`COMPOSE='-f docker-compose.yml -f docker-compose.prod.yml'`.)

0. **On a CD-managed VM, pin the deployed images first** — CD exports
   `API_IMAGE`/`MIGRATE_IMAGE` only in its own session, so steps 3–4 would otherwise
   start a stale `accounting-api[-migrate]:local` image
   (`deploy.md` → *Operator commands on a CD-managed VM*):
   `export API_IMAGE=$(docker inspect -f '{{.Config.Image}}' "$(docker compose $COMPOSE ps -a -q api)")`
   and the same with `MIGRATE_IMAGE` / `migrate`. (A VM that builds its own images
   resolves to `:local`, which is then correct.)
1. Stop writers: `docker compose $COMPOSE stop api migrate`.
2. Restore (drops & recreates objects from the dump; `db` and `backup` stay up):
   `docker compose $COMPOSE exec backup \
     pg_restore --clean --if-exists --no-owner -h db -U accounting -d accounting /backups/<file>`
   (the dump path is a positional arg — custom-format dumps are not read from stdin).
3. Re-apply any newer migrations (no-op if the dump is current): `docker compose $COMPOSE up -d --no-build migrate`.
4. Start the app: `docker compose $COMPOSE up -d --no-build`.

### Database role after a restore
The dump contains `GRANT … TO accounting_app` (the api's least-privilege role —
see [`deploy.md` → Database roles](./deploy.md#database-roles-least-privilege)).
Restoring into the existing `db` volume (the procedure above) keeps the role; step 3
(`up -d --no-build migrate`) re-runs the idempotent grants step anyway. Restoring into a
**fresh** cluster/volume: the postgres init hook creates `accounting_app` first
(`APP_DB_PASSWORD` must be set on `db`); anywhere else, either run
`node scripts/db/ensure-app-role.js` (via the `migrate` service) before
`pg_restore`, or ignore the `role "accounting_app" does not exist` GRANT warnings
and run it afterwards. The api cannot connect until the role exists.

### `posted_xid` after a restore into a fresh cluster
`journal_entries.posted_xid` records the transaction id that posted each entry; the
line-immutability trigger lets only *that* transaction insert lines into a posted
entry. `pg_restore` loads table data before it creates triggers, so the values are
restored verbatim.

- **Same cluster** (the procedure above, `--clean` into the running `db`): the
  cluster's xid counter is already past every restored value — nothing to do.
- **Fresh cluster** (new volume / new server): the xid counter restarts, so some
  future transaction may be assigned an xid equal to an old entry's `posted_xid`.
  That single transaction could then insert lines into that one old posted entry.
  **The application never does this** — it writes an entry's lines only in the same
  transaction that posts it (new entries get their own, new `posted_xid`) — so there
  is no application-visible effect; the gap is only in the defence against raw SQL.
  To close it anyway, right after the restore run, as the owner (`accounting`, the
  container superuser), before starting `api`:

  ```sql
  BEGIN;
  SET LOCAL session_replication_role = replica;  -- bypass the immutability trigger
  UPDATE journal_entries SET posted_xid = '0'::xid8
   WHERE posted_xid IS NOT NULL AND posted_xid <> '0'::xid8;
  COMMIT;
  ```

  `'0'` is the sentinel the ledger-integrity migration gave pre-existing entries: no
  live transaction ever has xid 0, so no transaction can add lines to them. (Proven
  by `test/db-integrity.e2e-spec.ts` → *restore hardening snippet*.)

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
