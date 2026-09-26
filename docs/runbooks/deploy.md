# Deploy Runbook (single VM)

## Prerequisites
- Docker + Docker Compose v2 on the VM; ports 80 and 443 open; DNS A-record for
  `$DOMAIN` pointing at the VM (required for Caddy auto-HTTPS).
- A `.env` next to the compose files (gitignored) with:
  `POSTGRES_PASSWORD` (DB owner), `APP_DB_PASSWORD` (the api's least-privilege
  `accounting_app` role — see [Database roles](#database-roles-least-privilege)),
  `JWT_ACCESS_SECRET` (>=32 chars), `JWT_REFRESH_SECRET` (>=32),
  `DOMAIN`. Both DB passwords are interpolated **unencoded** into connection URLs
  by compose (`postgresql://user:${PASSWORD}@db/...`), so they **must be URL-safe**:
  only `A-Z a-z 0-9 . _ ~ -` (e.g. `openssl rand -hex 24`). A reserved character
  (`@ : / ? # % [ ]`, space…) breaks or mis-parses the URL. Where you build a URL by
  hand (e.g. a one-off `DATABASE_URL` for a rehearsal), percent-encode any such
  character (`@` → `%40`). The `migrate` service first runs `ensure-app-role --check-only`,
  which **refuses** a non-URL-safe `APP_DB_PASSWORD` or `POSTGRES_PASSWORD` and fails
  the deploy before any migration runs or `api` starts. The two JWT secrets **must differ** (startup validation rejects equal
  secrets); `JWT_ACCESS_TTL` must be ≤ 3600s and `JWT_REFRESH_TTL` ≤ 30d, each a whole
  number **with a unit** `s`/`m`/`h`/`d` (e.g. `900s`, `7d`) — a unitless `900` is rejected
  at startup (jsonwebtoken would read it as 900 ms).
  Optional: `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`, `RETENTION_DAYS`,
  `BACKUP_INTERVAL`, `THROTTLE_LIMIT` (per-user requests/min, default 300),
  `THROTTLE_LOGIN_LIMIT` (per-email login attempts/min, default 10),
  `THROTTLE_LOGIN_IP_LIMIT` (per-client-IP login attempts/min across all emails, default 30),
  `ARGON2_MAX_CONCURRENCY` (concurrent password hash/verify per process, 1-64,
  default 8; callers queue ≤5s, then `503`),
  `TRUST_PROXY_HOPS` (Express `trust proxy` hop count; compose sets 1 for Caddy → api),
  `THROTTLE_REFRESH_LIMIT` (per-IP refresh attempts/min, default 30),
  `THROTTLE_CHANGE_PASSWORD_LIMIT` (per-user change-password attempts/min, default 10).
- **Redis** must be running and reachable at `REDIS_URL` before the API starts. The
  rate limiter is **fail-closed**: without Redis the API returns `503` on every
  throttled route, so a deploy can come up "running" (container healthy) yet 503 all
  business requests. The prod compose stack includes a `redis` service; if you run
  the API standalone, provision Redis and set `REDIS_URL` first.

## Deploy / upgrade
```bash
COMPOSE='docker compose -f docker-compose.yml -f docker-compose.prod.yml'
$COMPOSE build              # new api + migrate images (nothing restarts yet)
$COMPOSE stop api           # the OLD api must not run against the NEW schema
$COMPOSE up -d --no-build   # migrate → new api → caddy/backup
```
`build` tags the images `accounting-api:local` / `accounting-api-migrate:local`
(unless `API_IMAGE` / `MIGRATE_IMAGE` are set); `up` then runs `migrate` (prisma
migrate deploy, then the idempotent `accounting_app` grants step) to completion and
starts `api` (gated on `migrate` succeeding), `caddy`, and `backup`. `migrate` runs
**before** the app and never in-process.

**Why `stop api` first:** without it the previous api keeps serving while `migrate`
changes the schema underneath it. Old code is not guaranteed to satisfy new
constraints — e.g. before `20260925100000_add_voided_on`, a void wrote no
`voided_on`, which the new `*_voided_on_iff_void` CHECK rejects (a 500 to the user).
The api is down (Caddy returns 502) for the length of the migration; deploy in a
quiet window. CD does the same `stop api` → `up`.

To deploy the images CI published instead of building on the VM (what CD does):
```bash
export API_IMAGE=ghcr.io/<owner>/<repo>:<sha> MIGRATE_IMAGE=ghcr.io/<owner>/<repo>-migrate:<sha>
$COMPOSE pull
$COMPOSE stop api
$COMPOSE up -d --no-build
```
`--no-build` matters: `api`/`migrate` keep a `build:` section for local builds, and
without it compose could reuse a stale locally-built image.

## First deploy of the audit-3 release (checklist)

This release adds schema invariants, a least-privilege DB role and token changes.
Work through this **once**, on the first deploy that includes migrations
`20260925100000_add_voided_on` … `20260928000000_idempotency_reservation_token`:

1. **Rehearse the migration on a restored production backup first.** Restore the
   latest dump into a scratch database (`backup-and-restore.md` → *Test your
   restore*, but skip the `dropdb`), then run the NEW migrate image against it —
   after `$COMPOSE build` (or `pull` with `MIGRATE_IMAGE` set), without touching the
   live database:
   ```bash
   $COMPOSE run --rm --no-deps \
     -e DATABASE_URL="postgresql://accounting:${POSTGRES_PASSWORD}@db:5432/scratch?schema=public" \
     migrate npx prisma migrate deploy
   ```
   (`set -a; . ./.env; set +a` first so `POSTGRES_PASSWORD` is set; drop the scratch
   database afterwards). These migrations **abort (nothing applied) on legacy data** and name the rows:
   - `20260926100000_auth_hardening` — emails that differ only by case/whitespace;
   - `20260926200000_purchase_bill_vendor_invoice_unique` — duplicate live
     (partner, vendor invoice no.) bills;
   - `20260926300000_ledger_integrity` pre-flight — unbalanced / < 2-line posted
     entries, inconsistent status/posted fields, soft-deleted posted entries,
     payments with amount ≤ 0, allocations without exactly one target,
     `amount_paid` outside `[0, total]`, negative line quantity/price, bad or
     overlapping periods, and orphaned references (lines/documents/payments/tax
     codes pointing at missing accounts, partners, periods or journal entries);
   - `20260927000000_journal_link_fks` — `year_end_closings.closing_entry_id` /
     `reversal_of_id` / `reversed_by_id` pointing at missing journal entries.
   Fix the data by hand, mark a failed attempt with
   `npx prisma migrate resolve --rolled-back <migration>`, and re-run. Only deploy to
   production once the rehearsal applies cleanly.
2. **`APP_DB_PASSWORD` must be in `.env`** (compose refuses to start `db`,
   `migrate` and `api` without it). The `accounting_app` role does not exist on an
   existing volume until the `migrate` step of this deploy creates it — so `api`
   (which connects as `accounting_app`) can only start after `migrate` succeeded,
   which the compose `depends_on` enforces.
3. **`db` is recreated on this deploy** (its service definition gained the
   `APP_DB_PASSWORD` env and the init-hook mounts): expect a brief database
   restart. The init hook does not run on an existing volume — `migrate` covers it.
4. **Stop `api` before `migrate`** — use the sequence in *Deploy / upgrade* above
   (CD does it). The old code's void path lacks `voided_on` and would 500 against
   the new CHECK.
5. **Every user must log in again once**: tokens now carry a `typ` claim, so all
   access/refresh tokens issued before the deploy are rejected (`401`). Tell users
   (and the frontend team) beforehand.
6. **Legacy tax codes:** the tax-code account rule is now re-checked on every
   invoice/bill post. Run the read-only query in `troubleshooting.md` → *Posting an
   invoice/bill fails 422 with `details.taxAccountId`* against the rehearsal database;
   any rows it lists must be replaced (new conforming code, deactivate the old one,
   re-`PATCH` drafts) or their drafts cannot be posted.
7. After the deploy: `/ready` is 200, `docker compose logs migrate` ends with
   `ensure-app-role: accounting_app role + grants are up to date`, and a login +
   one read works.

## Database roles (least privilege)

| Role | Used by | Privileges |
|---|---|---|
| `accounting` (`POSTGRES_USER`, owner) | `migrate`, `backup`, operators | owns the schema; DDL |
| `accounting_app` | `api` (`DATABASE_URL` in `docker-compose.prod.yml`) | `SELECT/INSERT/UPDATE` on all tables, `DELETE` **only** on the hard-delete allow-list (`sales_invoice_lines`, `purchase_bill_lines`, `accounting_periods`, `idempotency_keys`, `refresh_tokens`), `USAGE/SELECT/UPDATE` on sequences; **no** TRUNCATE, **no** DDL, not superuser/createdb/createrole, owns nothing, no access to `_prisma_migrations`, INSERT/SELECT only on the append-only `audit_log` |

- **Where it is created:** `scripts/db/app-role.sql` (idempotent) is applied
  (a) by the postgres init hook `scripts/db/initdb/10-accounting-app-role.sh` on a
  **fresh** data volume, and (b) by the `migrate` service after every
  `prisma migrate deploy` (`node scripts/db/ensure-app-role.js`) — so **existing
  volumes are upgraded on the next deploy** and every table a new migration adds is
  granted SELECT/INSERT/UPDATE (default privileges cover owner-created future
  tables as well). Each run also revokes DELETE everywhere and re-grants it only on
  the allow-list, so an older deploy's blanket DELETE grant is removed on upgrade.
- **Env:** `APP_DB_PASSWORD` is required by `db` (init hook), `migrate` (grants step)
  and `api` (its `DATABASE_URL` is
  `postgresql://accounting_app:${APP_DB_PASSWORD}@db:5432/accounting`). `migrate`'s
  `DATABASE_URL` stays the owner URL (`POSTGRES_PASSWORD`). The password is never
  hard-coded or echoed to logs.
- **Rotate `APP_DB_PASSWORD`:** change it in `.env` and redeploy — `migrate` re-sets
  the role's password before `api` restarts with the new one. The `db` service
  carries the variable too (for its init hook), so a changed value **recreates the
  `db` container — a brief database restart**; rotate in a quiet window.
- **Rotate `POSTGRES_PASSWORD` (owner) on an existing volume** — e.g. when the new
  URL-safe check refuses a legacy password containing `+`, `/` or `=`: the owner
  password is stored **in the data volume**, so changing `.env` alone locks
  `migrate`/`backup` out. First set the new (URL-safe) password in the database,
  connecting over the container's local socket (no password needed there):
  ```bash
  NEW=$(openssl rand -hex 24)
  $COMPOSE exec db psql -U accounting -d accounting \
    -c "ALTER ROLE accounting PASSWORD '$NEW'"
  ```
  then put `POSTGRES_PASSWORD=$NEW` in `.env` and redeploy (`db` is recreated because
  its env changed — a brief restart; `migrate`, `backup` and any operator URLs use
  the new value). Keep the old `.env` until `migrate` has succeeded.
- **First deploy on an existing volume:** nothing manual — `migrate` creates the role.
  Until that step has run, `accounting_app` does not exist and `api` cannot connect
  (compose starts `api` only after `migrate` succeeds). If the grants step fails it
  reports only `accounting_app role create/alter failed: <SQLSTATE>` — the password
  is never echoed into the error or the server log.
- **Restore:** a `pg_dump` contains GRANTs to `accounting_app`; restoring into a fresh
  volume is fine (the init hook creates the role first). Restoring elsewhere, create
  the role first (run the grants step) or ignore the `role does not exist` GRANT
  warnings and run the grants step afterwards. See also
  [`backup-and-restore.md`](./backup-and-restore.md) (role + `posted_xid` notes).
- **Local dev is unaffected:** `.env.development` keeps connecting as the owner
  (see `local-development.md`). Tests (testcontainers) use the container superuser;
  `test/db-app-role.e2e-spec.ts` proves the app runs as `accounting_app` (incl.
  draft edit → post → pay → void flows), that TRUNCATE/DDL are denied, and that
  DELETE is denied on every table outside the allow-list.

## Health & shutdown
- `api` is healthy when `/ready` returns 200 (DB + Redis reachable — a dependency outage now marks the container unhealthy); `/health` stays a bare liveness probe. Caddy proxies only a started app.
- **Edge exposure:** Caddy answers `404` for `/ready*` and `/metrics*` (dependency state and metrics are internal). The container healthcheck (`127.0.0.1:3000/ready`) and Prometheus (`api:3000/metrics`) bypass Caddy, so they are unaffected; external uptime probes use `https://$DOMAIN/health`. Check readiness from the VM with `docker compose exec api node -e "require('http').get('http://127.0.0.1:3000/ready',r=>console.log(r.statusCode))"`.
- One-time caveat (AUDIT3-7, `20260926100000_auth_hardening`): the migration
  lowercases `users.email` and adds a unique index on `lower(email)`. It **aborts
  with a clear error listing the emails** if two accounts differ only by
  case/whitespace — nothing is applied (the check runs first). Resolve those
  accounts by hand (rename/tombstone one), mark the failed attempt with
  `npx prisma migrate resolve --rolled-back 20260926100000_auth_hardening`, and
  re-run the deploy. Tokens now carry a `typ` claim: every access/refresh token issued
  before the deploy is rejected, so all users log in again once.
- One-time caveat: migration `20260705163429_scope_idempotency_keys_by_user`
  clears the `idempotency_keys` cache to add the NOT NULL `user_id` column. On
  the deploy that first applies it, a client retrying a write completed in the
  previous ~24h with the same `Idempotency-Key` re-executes instead of
  replaying — apply it in a low-traffic window.
- `SIGTERM` (e.g. `docker compose ... stop api`) triggers a graceful Nest shutdown
  (idle keep-alive sockets close, in-flight requests finish within `stop_grace_period` = 45s, THEN Prisma/Redis disconnect).

## X-Forwarded-For / client IP trust (SEC-3)
Caddy (the TLS edge) **ignores any client-supplied `X-Forwarded-For` by default**
to prevent spoofing — it sets `X-Forwarded-For` to the real connecting client
before proxying to `api`. The app's `trust proxy` hop count (`TRUST_PROXY_HOPS`,
default **1 in production**, 0 elsewhere; compose passes 1) makes `req.ip` the
right-most `X-Forwarded-For` entry — the one Caddy wrote — so the per-IP login
ceiling (`THROTTLE_LOGIN_IP_LIMIT`) and audit IPs use the true client address and
cannot be bypassed with a forged header. **If you add a CDN/LB in front of Caddy,
raise `TRUST_PROXY_HOPS` to the number of proxies** (and configure Caddy as below);
if the API is ever exposed without Caddy, set it to 0.
No Caddy directive is required; this is the default behavior of `reverse_proxy`.
(The app-side per-account login throttle — keyed by the submitted email — is the
complementary defense already in place.)

**Only if a CDN or L4 load balancer is ever placed in front of Caddy**, Caddy
must be told to trust it so it accepts the upstream's `X-Forwarded-For`:
```caddyfile
reverse_proxy api:3000 {
	trusted_proxies static private_ranges
}
```
Add the global option `trusted_proxies_strict` for right-to-left XFF parsing when
the upstream appends to the right (CloudFlare, AWS ALB, HAProxy) — this prevents
leftmost-IP spoofing.

**Deploy-time verification:** against a deployed instance, hammer the login limit
from one source while rotating a forged `X-Forwarded-For`; it should still 429
(the forged header is ignored), confirming the real client IP is used.

## Rollback

1. **App-only rollback (no schema change):** redeploy the previous image tag/commit —
   check out the prior commit and export its `API_IMAGE` / `MIGRATE_IMAGE`
   (`ghcr.io/<owner>/<repo>[-migrate]:<prior-sha>`), then `pull` +
   `up -d --no-build` (or `up -d --build` for a VM-built image). Caddy/api/backup
   restart against the unchanged DB.
2. **Migrations are forward-only.** Rolling back the image does NOT undo a migration.
   If a bad migration shipped:
   a. Stop the API: `docker compose ... stop api`.
   b. Prefer a **corrective forward migration** (a new migration that fixes the bad
      one) over editing history — never edit an already-applied migration.
   c. If data is corrupted, **restore from backup**: follow `backup-and-restore.md`
      (stop `api`, restore the latest good `pg_dump -Fc` into the `db` volume, then
      bring `api` back up). Accept the data delta since that backup.
3. After any rollback, verify `/health` (200) and `/ready` (200 — DB + Redis reachable).

## Monitoring (optional)

An optional observability overlay ships in `docker-compose.monitoring.yml`
(Prometheus + Grafana + alertmanager + **Loki/Alloy log aggregation**).
The subsections below explain each piece; this checklist is the whole
activation, in order:

### Bring the stack up (checklist)

1. **On the VM, add to the `.env`** next to the compose files:

   ```bash
   GRAFANA_ADMIN_PASSWORD=<strong password>        # required
   ALERT_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...   # or ALERT_WEBHOOK_URL (see below)
   # ALERT_SLACK_CHANNEL=#alerts                   # optional override
   # ALERT_HEARTBEAT_URL=https://hc-ping.com/<uuid>  # optional dead-man's switch
   ```

2. **Deploy with the overlay added** (same command as always, one more `-f`):

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml \
     -f docker-compose.monitoring.yml up -d --build
   ```

3. **Confirm delivery is armed:** `docker compose logs alertmanager | head`
   must show `alert delivery ACTIVE (...)` — a `WARN: no ALERT_*_URL set`
   means step 1's variable didn't reach the container.

4. **Open Grafana — via SSH tunnel.** Grafana (3001) and Prometheus (9090)
   bind to `127.0.0.1` on the VM on purpose (not exposed through Caddy):

   ```bash
   ssh -L 3001:127.0.0.1:3001 -L 9090:127.0.0.1:9090 <user>@<vm>
   ```

   Then browse `http://localhost:3001` (admin / `GRAFANA_ADMIN_PASSWORD`).
   The accounting dashboard and both datasources (Prometheus, Loki) are
   auto-provisioned; logs live under **Explore → Loki**.

5. **Fire-drill the alerting** (do this once — an alert channel you've never
   seen a message in is not activated): `docker compose stop api`, wait ~3
   minutes, confirm `ApiDown` lands in the channel, then
   `docker compose start api` and confirm the resolved notice.

6. **Create the external uptime check** (OPS-OBS-5): a free UptimeRobot /
   healthchecks.io / Better Stack probe on `https://$DOMAIN/health`, 1-minute
   interval — see the failure-domain note at the end of this section.

Steps 1–5 are one sitting on the VM; step 6 is a two-minute signup anywhere.

### Logs (Loki + Alloy)

Alloy tails every compose container via the Docker socket and pushes to Loki
(single-binary, filesystem storage, **30-day retention**, internal-only — no
published port). Grafana auto-provisions the Loki datasource: **Explore →
Loki**, query by compose service, then filter pino JSON at query time, e.g.

```logql
{service="api"} | json | req_id="<traceId>"     # full story of one request
{service="api"} | json | level >= 40             # warn+error only
```

Keep labels minimal (only `service`/`container` are indexed — that's
deliberate; don't promote traceId or route to labels). Backfill note: on first
start Alloy reads existing log files; entries older than Loki's 7-day ingest
window are dropped with a one-time burst of `400 timestamp too old` in alloy
logs — harmless. Positions persist in the `alloy_data` volume, so restarts
resume instead of re-reading.

> **Metrics auth coupling (OPS-OBS-4):** if you set `METRICS_TOKEN` on the api, you MUST
> uncomment the `authorization.credentials` block in `monitoring/prometheus.yml` with the
> same token, or scrapes get `401` and the `ApiDown` alert false-fires.

### Activate alert delivery (OPS-OBS-1)

Delivery is **env-driven** — no YAML editing. Set ONE variable in the `.env` next
to the compose files and restart alertmanager:

- `ALERT_SLACK_WEBHOOK_URL` — native Slack receiver (optional
  `ALERT_SLACK_CHANNEL`, default `#alerts`). Use this for Slack: incoming
  webhooks reject Alertmanager's generic JSON, so a Slack URL in the generic
  var would 400 and drop every alert.
- `ALERT_WEBHOOK_URL` — generic webhook receiver (a custom handler, or Discord
  with a `/slack`-suffixed URL).

The alertmanager entrypoint substitutes the URL into
`monitoring/alertmanager-slack.yml` / `alertmanager-webhook.yml` at startup and
logs `alert delivery ACTIVE (...)`; with neither var set it falls back to the
inert `monitoring/alertmanager.yml` and logs a WARN. Unresolved alerts re-notify
every 4h. Send a test by triggering a rule (e.g. stop the api so `ApiDown`
fires) and confirm it lands in the channel.

Optionally also set `ALERT_HEARTBEAT_URL` (e.g. a [healthchecks.io](https://healthchecks.io)
ping URL with a ~15-minute grace period): the always-firing `Watchdog` alert
POSTs there every ~10 minutes and **never** reaches the notification channel.
If the heartbeat goes silent, the Prometheus→Alertmanager pipeline itself is
down — the failure mode no in-VM alert can report.

> **The VM is one failure domain.** Prometheus and the API share the machine,
> so whole-VM death silences everything above. Pair the heartbeat with an
> **external uptime check** (UptimeRobot / healthchecks.io / Better Stack)
> probing `https://$DOMAIN/health` from outside — that is the only monitor
> that catches the VM itself dying.

## Staging without a public domain
Don't edit the committed `Caddyfile` (it would dirty the repo and risk shipping a
non-prod TLS setting). Instead either:
- **Skip Caddy:** smoke-test `db`+`migrate`+`api` only and curl `http://127.0.0.1:3000/health`
  (`docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d db migrate api`); or
- **Throwaway internal TLS:** copy the Caddyfile, append `tls internal`, and mount the copy
  via a one-off override file — e.g. `cp Caddyfile /tmp/Caddyfile.staging && printf '\n\ttls internal\n' >> /tmp/Caddyfile.staging`, then a small `docker-compose.staging.yml` that remaps `caddy.volumes` to `/tmp/Caddyfile.staging:/etc/caddy/Caddyfile:ro`, and add `-f docker-compose.staging.yml` to the up command. `DOMAIN=localhost`, then `curl -k https://localhost/health`.

### Activate offsite + encrypted backups (OPS-DB-1)

`scripts/backup.sh` writes a local `pg_dump` by default. To also encrypt and ship
offsite, set env on the `backup` service (all optional; unset = local-only, as today):
- `BACKUP_AGE_RECIPIENT` — an [age](https://age-encryption.org) recipient public key;
  the dump is encrypted to `*.dump.age` before leaving the host.
- **S3:** `BACKUP_S3_BUCKET` (e.g. `my-bucket/accounting`) + AWS creds (`AWS_ACCESS_KEY_ID`/
  `AWS_SECRET_ACCESS_KEY`/`AWS_DEFAULT_REGION`) for `aws`, or an `rclone` remote config.
- **rsync:** `BACKUP_RSYNC_TARGET` (e.g. `user@host:/backups/`) with SSH access.

The default `backup` image (`postgres:16`) does NOT include `age`/`aws`/`rclone`/`rsync`.
Provide them via a custom backup image (recommended) or a bind-mount; the script logs a
clear WARN and keeps the local dump if a configured tool is missing. Restore: decrypt
with `age -d -i <key> file.dump.age > file.dump`, then follow `backup-and-restore.md`.

## CD pipeline (OPS-CI-1)

`.github/workflows/cd.yml` is **manual** (`workflow_dispatch`) — it does NOT run on push.
To release: GitHub → **Actions** → **CD** → **Run workflow** → pick the **tag** (or branch)
from the ref dropdown → **Run**. It builds/deploys exactly the selected ref.
0. **CI gate** — the run fails immediately unless `ci.yml` has a **successful
   push-to-`main` run for the exact commit SHA** being released (Actions API query with
   `event=push&branch=main`). A green PR run for an unmerged head does not qualify, so
   only commits that landed on `main` (or tags cut from them) can be released.
   **Recommended hardening (GitHub settings, not code):** create a GitHub
   **Environment** (e.g. `production`) holding the `DEPLOY_SSH_*` secrets, with a
   *deployment branch/tag policy* allowing only `main` and your release tag pattern
   (e.g. `v*`) and, optionally, required reviewers; then add `environment: production`
   to the `deploy` job. Environment secrets are only released to runs whose ref
   passes the policy, so a dispatch from an arbitrary branch cannot reach the VM.
1. **Publish** — builds and pushes TWO images using the built-in `GITHUB_TOKEN` (no
   extra secret; ensure the repo's Package settings allow Actions to write packages):
   - runtime (`production` stage) → `ghcr.io/<owner>/<repo>:<sha>` (+ `:<tag>`, `:latest`)
   - migrate (`build` stage — prisma CLI + migrations + `scripts/db`) →
     `ghcr.io/<owner>/<repo>-migrate:<sha>` (+ `:<tag>`, `:latest`)

   (`<tag>` = the selected ref name, e.g. `v1.2.0`, with every character outside
   `[A-Za-z0-9_.-]` — e.g. the `/` in `release/1.2` — replaced by `-`, since Docker
   tags can't contain it.) Tip: create an annotated tag first
   (`git tag -a v1.2.0 -m ... && git push origin v1.2.0`), then select it in the dropdown.
2. **Deploy (optional, gated)** — runs ONLY if a `DEPLOY_SSH_HOST` secret is set. Add
   `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PATH` (repo dir on the
   VM) as Actions secrets. Over SSH it checks the repo out at the released SHA (if
   `DEPLOY_PATH` is a git checkout), exports `API_IMAGE` / `MIGRATE_IMAGE` = the
   immutable `:<sha>` images, and runs `compose pull`, `compose stop api` (the old api
   must not run against the new schema) and `compose up -d --no-build` (migrate, then
   the new api).
   The VM must be logged in to GHCR if the packages are private
   (`docker login ghcr.io` with a `read:packages` token) and its `.env` must contain
   `APP_DB_PASSWORD`. Until the secrets exist, CD only publishes.

All workflow actions are pinned to full commit SHAs (with a `# vX.Y.Z` comment);
bump them by resolving the new tag's commit (`gh api repos/<o>/<r>/git/ref/tags/<tag>`,
dereferencing annotated tags via `git/tags/<sha>`), never by switching back to a tag.

## Activating CI (SEC-8)
The CI workflow (`.github/workflows/ci.yml`) is committed but dormant — the repo
has no git remote, so nothing triggers it. To activate:
```bash
# 1. Create a GitHub repository, then add it as the remote:
git remote add origin git@github.com:<org>/accounting-api.git
# 2. Push main (this triggers CI on push):
git push -u origin main
```
On push/PR to `main`, CI runs three jobs: `verify` (Prisma generate + typecheck +
lint + unit + e2e with coverage), `audit` (`npm run audit:ci`, fails on a
moderate-or-higher advisory in prod deps), and `docker` (production image build +
Trivy HIGH/CRITICAL vulnerability scan, `exit-code 1`).
Recommended next step: enable branch protection on `main` requiring the `verify`
and `audit` checks to pass before merge.
