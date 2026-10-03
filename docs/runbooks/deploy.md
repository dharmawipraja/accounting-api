# Deploy Runbook (single VM)

## Prerequisites
- Docker + Docker Compose **v2.24.0 or newer** on the VM (`docker-compose.prod.yml`
  uses `ports: !reset []` to drop the api/db/redis host ports — older Compose fails to
  parse it; check with `docker compose version`); ports 80 and 443 open; DNS A-record for
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
  Optional: `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`, `RETENTION_DAYS` (days, bare
  integer ≥ 1, default 7), `BACKUP_INTERVAL` (seconds, bare integer ≥ 60, default
  86400) — anything else (`abc`, `1.5`, a value that still carries quotes after `.env`
  parsing such as `'"30"'`) makes the `backup` sidecar log the error and exit 64
  **without dumping** (it restarts ~once a minute until fixed; check
  `$COMPOSE logs backup`), `THROTTLE_LIMIT` (per-user requests/min, default 300),
  `THROTTLE_LOGIN_LIMIT` (login attempts/min per (email, client IP), default 10),
  `LOGIN_FAILURE_LIMIT` (failed logins per account per 15 min, default 20; past it the
  account refuses logins from IPs it has never logged in from — `auth_login_lockouts_total`),
  `LOGIN_FAILURE_HARD_LIMIT` (absolute failed logins per account per 15 min, default 100;
  past it EVERY IP is refused, known ones too — bounds a guesser sharing the owner's IP;
  same `auth_login_lockouts_total` metric),
  `THROTTLE_LOGIN_IP_LIMIT` (per-client-IP login attempts/min across all emails, default 30),
  `ARGON2_MAX_CONCURRENCY` (concurrent password hash/verify per process, 1-64,
  default 8; callers queue ≤5s, then `503`),
  `TRUST_PROXY_HOPS` (Express `trust proxy` hop count; `docker-compose.prod.yml` defaults it
  to 1 for Caddy → api, the base `docker-compose.yml` alone — api published directly,
  no Caddy — to 0),
  `THROTTLE_REFRESH_LIMIT` (per-IP refresh attempts/min, default 30),
  `REFRESH_REUSE_GRACE_MS` (ONE replay of a just-rotated refresh token within this
  window is a concurrent refresh, not theft — a second replay revokes the session;
  default 5000, 0–30000, 0 = off),
  `THROTTLE_CHANGE_PASSWORD_LIMIT` (per-user change-password attempts/min, default 10),
  `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` (default `900s` / `7d`),
  `REQUEST_TIMEOUT_MS` (per-request cap → `408`, default 35000; keep
  `DB_STATEMENT_TIMEOUT_MS` < it < the 40s socket timeout),
  `REPORT_UTC_OFFSET_MINUTES` (defaulted report "today", default 420 = WIB),
  `IDEMPOTENCY_INFLIGHT_TTL_MS` / `IDEMPOTENCY_COMPLETED_TTL_MS` (default 120000 /
  86400000), `LOG_LEVEL` (default `info`), `ENABLE_SWAGGER` (default `false`),
  `CORS_ORIGIN` (comma-separated browser origins, e.g. `https://app.example.com`;
  **unset/empty = CORS disabled** — a browser frontend on another origin cannot call
  the API. Under `NODE_ENV=production` startup validation **rejects** any entry that is
  `*`, not an exact `https://host[:port]` origin (no `http://`, trailing `/`, path,
  query or upper-case — the browser's `Origin` header is matched verbatim), or a
  localhost / `127.x` / `::1` / `0.0.0.0` host — so the `.env.example` value
  `http://localhost:5173` left in a production `.env` stops the api from booting
  instead of silently locking the real frontend out. Set the real frontend origin(s),
  or leave it empty for server-to-server-only use, e.g. a staging stack on `localhost`),
  `METRICS_TOKEN` (bearer token for `/metrics`; unset = `/metrics` answers `401` in
  production), `SENTRY_DSN` (unset = no error reporting), `SENTRY_ENVIRONMENT`
  (default `NODE_ENV`), `SENTRY_RELEASE`.
  Every one of these reaches the api only because `docker-compose.yml` (or, for the
  two `DB_*` vars and the prod `TRUST_PROXY_HOPS` default, `docker-compose.prod.yml`) passes it through as
  `${VAR:-<default>}`; a var the app reads that is not listed there never reaches the
  container. Numeric/enum vars carry the app's own default (an empty string would fail
  startup validation); the empty-means-off vars (`CORS_ORIGIN`, `METRICS_TOKEN`,
  `SENTRY_*`) default to `''`, which the app treats exactly like unset. Check what
  the api will receive with
  `$COMPOSE config api` (`$COMPOSE` = the prod pair, defined in *Deploy / upgrade* below).
- **Redis** must be running and reachable at `REDIS_URL` before the API starts. The
  rate limiter is **fail-closed**: without Redis the API returns `503` on every
  throttled route, so a deploy can come up "running" (container healthy) yet 503 all
  business requests. The prod compose stack includes a `redis` service; if you run
  the API standalone, provision Redis and set `REDIS_URL` first.

## Deploy / upgrade
```bash
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
$COMPOSE build              # new api + migrate images (nothing restarts yet)
$COMPOSE stop api           # the OLD api must not run against the NEW schema
$COMPOSE up -d --no-build   # migrate → new api → caddy/backup
# Caddyfile / scripts/backup.sh changed? up does NOT pick that up — recreate it:
#   $COMPOSE up -d --no-build --no-deps --force-recreate caddy   (see below)
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
# + the Caddyfile / backup.sh recreate below when either changed (CD does it)
```
`--no-build` matters: `api`/`migrate` keep a `build:` section for local builds, and
without it compose could reuse a stale locally-built image.

### Changed `Caddyfile` / `scripts/backup.sh`: recreate that service
`caddy` mounts `./Caddyfile` and `backup` mounts `./scripts/backup.sh` as
**single-file bind mounts**, which pin the file's inode. `git checkout` / `git pull`
replaces a changed file with a **new** inode, so the running container keeps
reading the **old** content — and `up -d` recreates a service only when its compose
*definition* changed, which a Caddyfile edit does not do. `caddy reload` does not
help either: inside the container `/etc/caddy/Caddyfile` is still the old file
(on a Linux host the mount keeps the old inode's content; Docker Desktop shows the
file as missing) (verified on Docker Compose v5.1.2: after a `git checkout` that added the `/ready`
block, `/ready` kept answering 200 through `up -d --no-build` and `caddy reload`,
and switched to 404 only after the recreate below). So whenever a deploy changes
one of them, recreate just that service:
```bash
$COMPOSE up -d --no-build --no-deps --force-recreate caddy    # Caddyfile changed
$COMPOSE up -d --no-build --no-deps --force-recreate backup   # scripts/backup.sh changed
```
`--no-deps` leaves `api`/`migrate`/`db` alone (no image pin needed — neither
service uses `API_IMAGE`/`MIGRATE_IMAGE`). Recreating `caddy` is safe on a live VM:
connections are refused for about a second while the container restarts, and the
certificates persist in the `caddy_data` volume (no re-issue). Recreating `backup`
aborts a dump in progress and takes a fresh one on start. Then verify from
**outside** the VM:
```bash
curl -s -o /dev/null -w '%{http_code}\n' https://$DOMAIN/ready    # 404
curl -s -o /dev/null -w '%{http_code}\n' https://$DOMAIN/metrics  # 404
curl -s -o /dev/null -w '%{http_code}\n' https://$DOMAIN/health   # 200
```
**CD does this automatically**, keyed on what is actually running: after
`up -d --no-build` it compares the file each **running** container reads with the
checked-out one and force-recreates only the service whose content differs — or
whose file it cannot read (service not running, file missing):
```bash
$COMPOSE exec -T caddy cat /etc/caddy/Caddyfile | cmp -s - Caddyfile \
  || $COMPOSE up -d --no-build --no-deps --force-recreate caddy
$COMPOSE exec -T backup cat /backup.sh | cmp -s - scripts/backup.sh \
  || $COMPOSE up -d --no-build --no-deps --force-recreate backup
```
Because it does not depend on git history, a **re-run** after a failed deploy
still converges (the VM is already on the new commit, yet the stale container is
caught), and a second run is a no-op (nothing differs). Run the same two lines
yourself after a **manual** `git checkout` / `git pull` on the VM (e.g. a rollback)
— they are safe to run any time (verified with a local prod-like Caddy: the
Caddyfile replaced by `mv` → recreated, `/ready` 404; the next run printed no
recreate). When the monitoring overlay is running (a `prometheus` container
exists), CD does the same for **Prometheus** (`monitoring/prometheus.yml`,
`alerts.yml`) and **Alertmanager** (`alertmanager*.yml`), so new alert rules take
effect on deploy. `loki.yml` / `alloy.alloy` are still manual: after a change,
recreate that overlay service the same way (`$COMPOSE -f
docker-compose.monitoring.yml up -d --no-build --no-deps --force-recreate <service>`).

### Operator commands on a CD-managed VM
CD exports `API_IMAGE` / `MIGRATE_IMAGE` **only inside its own SSH session**. In your
shell they are unset, so any compose command that (re)creates `api` or `migrate`
resolves them to `accounting-api:local` / `accounting-api-migrate:local` — a
**stale** image from some earlier VM build (with a changed definition compose
recreates the container from it), a fresh build of whatever is checked out (if
`--no-build` is missing), or a failed pull (if no such tag exists). Before any
`up` / `run` that touches `api` or `migrate` on a VM that CD deploys, pin the
images that are actually deployed:
```bash
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
export API_IMAGE=$(docker inspect -f '{{.Config.Image}}' "$($COMPOSE ps -a -q api)")
export MIGRATE_IMAGE=$(docker inspect -f '{{.Config.Image}}' "$($COMPOSE ps -a -q migrate)")
echo "api=$API_IMAGE migrate=$MIGRATE_IMAGE"   # must be ghcr.io/<owner>/<repo>[-migrate]:<sha>
```
(`-a` also finds the exited `migrate` / a stopped `api`. If either is empty, no such
container exists — export the tags of the last CD run by hand: the full commit SHA
from the last successful CD run in GitHub Actions or the GHCR package versions,
`ghcr.io/<owner>/<repo>:<sha>` / `ghcr.io/<owner>/<repo>-migrate:<sha>`.) Then:
- always pass **`--no-build`** to `up` (`run` never builds an image that exists);
- restart a single service with **`--no-deps`** — `$COMPOSE up -d --no-build --no-deps api`
  — otherwise `up -d api` also re-runs its `migrate` dependency;
- never recreate everything with a bare `up -d` / `up -d --build`.

On a VM where you build the images yourself (`$COMPOSE build`, no CD), the pin
resolves to `accounting-api:local` / `accounting-api-migrate:local`, which then IS
the deployed image — the same commands work unchanged.

## First install on a fresh VM (checklist)

1. Clone the repo into `$DEPLOY_PATH`, write the `.env` (see *Prerequisites*), and
   deploy (*Deploy / upgrade* above; on a fresh volume the db init hook creates the
   `accounting_app` role before the first migration).
2. **Create the first ADMIN.** There is no registration endpoint. The api image
   ships the compiled bootstrap script (`dist/scripts/create-admin.js`) and already
   carries its `DATABASE_URL` (the least-privilege `accounting_app` URL — enough:
   the script only needs SELECT/INSERT/UPDATE on `users`, UPDATE on
   `refresh_tokens`, row locks and advisory locks; `test/db-app-role.e2e-spec.ts`
   runs it as that role). Run it **inside the running api container** with
   `exec` — that is the exact image and environment that is deployed (no npm, no
   dotenv file, no host DB port needed). Pass the password via `ADMIN_PASSWORD` so
   it stays out of shell history and `ps`:
   ```bash
   COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
   read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD     # 8-128 chars (login's limits)
   $COMPOSE exec -e ADMIN_PASSWORD api \
     node dist/scripts/create-admin.js admin@acme.co "Budi Admin"
   unset ADMIN_PASSWORD
   ```
   **Only if the api is not running** (e.g. it cannot start yet), use a one-off
   container instead — but first point compose at the image that is actually
   deployed: outside CD's session `API_IMAGE` is unset, so `run` would fall back to
   `accounting-api:local` and build or run a **stale** image (an older script
   without the temp-password / session-revoke semantics):
   ```bash
   export API_IMAGE=ghcr.io/<owner>/<repo>:<sha>        # the deployed/pulled tag
   $COMPOSE run --rm --no-deps -e ADMIN_PASSWORD api \
     node dist/scripts/create-admin.js admin@acme.co "Budi Admin"
   unset ADMIN_PASSWORD
   ```
   The tag is the full commit SHA CD deployed: take it from the last successful
   **CD** workflow run in GitHub Actions (its `deploy` job's `API_IMAGE` / the run's
   commit), or from the GHCR package's versions list (`ghcr.io/<owner>/<repo>`,
   newest `<sha>` tag); `docker image ls ghcr.io/<owner>/<repo>` on the VM shows the
   pulled ones.
   (When you built on the VM with `$COMPOSE build`, `accounting-api:local` IS the
   deployed image and no export is needed. On a CD-managed VM whose api container
   exists but is stopped, the pin in *Operator commands on a CD-managed VM* reads
   the tag from it.)
   `exec -e ADMIN_PASSWORD` (a bare key, no `=value`) forwards the value from your
   shell's environment — it must be **exported** (`read -rs` alone sets a shell
   variable that `exec` does not see, and the script then fails with its
   missing-password usage error, touching nothing). Verified on Docker Compose
   v5.1.2; the `-e ADMIN_PASSWORD="$ADMIN_PASSWORD"` form works too, but prefer the
   bare key: the expanded value would show up in `ps` on the host while the
   command runs.
   It prints `✓ ADMIN ready: <email> (id …; created)`. The email is trimmed +
   lower-cased. The password you chose is a **temporary** one, exactly like an
   admin-issued temp password: `mustChangePassword` is set, so login works but every
   other route answers `403 PASSWORD_CHANGE_REQUIRED` until
   `POST /v1/auth/change-password`. An existing live user with that email is **reset**
   instead (new temp password, role ADMIN, re-activated, and **all its refresh tokens
   revoked** in the same transaction) — so the same command is the break-glass reset
   for a locked-out last admin, and any stale session dies with it. Every further
   user is created by that ADMIN via `POST /v1/users`.
3. Log in once (`POST https://$DOMAIN/v1/auth/login`), change the password
   (`POST /v1/auth/change-password` with `currentPassword` / `newPassword`), then do
   one read, e.g. `GET /v1/users`, to confirm the stack end to end.

## First deploy of the audit-3 release (checklist)

This release adds schema invariants, a least-privilege DB role and token changes.
Work through this **once**, on the first deploy that includes migrations
`20260925000000_accum_depreciation_cash_flow` … `20261005300000_users_email_nfc`
(if an earlier audit-3 deploy already applied some of them, the rehearsal simply
skips those — the list below still applies to the ones that remain):

1. **Rehearse the migration on a restored production backup first.** Restore the
   latest dump into a scratch database (`backup-and-restore.md` → *Test your
   restore*, but skip the `dropdb`), then run the NEW migrate image against it —
   after `$COMPOSE build` (or `pull` with `MIGRATE_IMAGE` set), without touching the
   live database:
   ```bash
   $COMPOSE run --rm --no-deps \
     -e DATABASE_URL="postgresql://accounting:${POSTGRES_PASSWORD}@db:5432/scratch?schema=public" \
     migrate node_modules/.bin/prisma migrate deploy
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
     `reversal_of_id` / `reversed_by_id` pointing at missing journal entries;
   - `20260930000000_purchase_bill_vendor_invoice_normalized` — live (not deleted,
     not VOID) bills of one partner whose vendor invoice numbers collide once
     normalized (`lower(btrim(...))`, e.g. `INV-1` / `inv-1` / ` INV-1 `);
   - `20261002000000_document_journal_link_check_and_fk_indexes` — sales invoices,
     purchase bills or payments whose `journal_entry_id` does not match their
     status (a DRAFT with a journal entry, or a POSTED/VOID one without);
   - `20261004000000_business_partner_customer_or_vendor_check` — business partners
     (soft-deleted included) that are neither customer nor vendor;
   - `20261005000000_identifier_code_ci_unique` — live account / tax-code / partner
     codes that **block**: codes that collide once normalized
     (`lower(trim(NFKC(code)))`, e.g. `KAS-1` / `kas-1` / ` KAS-1`), codes blank after
     normalization, codes containing an invisible character — format (zero-width
     space, BOM, bidi control, soft hyphen, tag characters …), control, line /
     paragraph separator, or other default-ignorable (combining grapheme joiner,
     Hangul filler, variation selector …; the error shows them as `\uXXXX`) — and
     codes whose normalized form equals the exact code of a soft-deleted row.
     Everything else that is merely **untrimmed or NFKC-different** (surrounding
     spaces incl. NEL / U+2028, full-width `ＫＡＳ-１`) is **auto-fixed** in place to
     `trim(NFKC(code))` (case kept) — each change writes an **audit row** (below);
   - `20261005300000_users_email_nfc` — users whose emails are the same address once
     NFC-normalized (a precomposed and a decomposed `josé@…`). Every other
     decomposed (NFD) email is rewritten to NFC (an **audit row** each) — without
     that such users could no longer log in — and a CHECK then keeps emails NFC.

   **Preview the auto-fixes before migrating** (read-only; run against the scratch
   database, or production itself — they change nothing), so you can tell users
   whose codes / emails will change:
   ```bash
   $COMPOSE exec -T db psql -U accounting -d scratch <<'SQL'
   SELECT t, id, code AS old, normalized AS new FROM (
     SELECT 'accounts' t, id, code, btrim(normalize(code, NFKC), E'\u0009\u000A\u000B\u000C\u000D\u0020\u0085\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000') normalized
       FROM accounts WHERE deleted_at IS NULL
     UNION ALL
     SELECT 'tax_codes', id, code, btrim(normalize(code, NFKC), E'\u0009\u000A\u000B\u000C\u000D\u0020\u0085\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000')
       FROM tax_codes WHERE deleted_at IS NULL
     UNION ALL
     SELECT 'business_partners', id, code, btrim(normalize(code, NFKC), E'\u0009\u000A\u000B\u000C\u000D\u0020\u0085\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000')
       FROM business_partners WHERE deleted_at IS NULL
   ) c WHERE code <> normalized ORDER BY 1, 3;
   SELECT id, email AS old, normalize(email, NFC) AS new
     FROM users WHERE email IS NOT NFC NORMALIZED;
   SQL
   ```
   (The escape list is JavaScript's `\p{White_Space}` — the trim the API applies.)
   `prisma migrate deploy` does **not** print the migrations' `NOTICE` lines, so the
   durable record is the audit log: **after migrating, `GET /v1/audit?method=MIGRATION`
   (ADMIN) lists every change** — one row per rewritten code / email, `path` = the
   migration name, `body` = `{ table, id, old, new }`, `userId` = `null`. No change,
   no row.

   The others in the range cannot abort on data: `20260925000000_accum_depreciation_cash_flow`
   is a data-only reclassification — every credit-normal `ASSET` account (contra-asset,
   i.e. accumulated depreciation) tagged `INVESTING` is re-tagged
   `cash_flow_category = 'NONE'`, so the cash-flow statement treats its movement as a
   non-cash add-back under *Operating* instead of an *Investing* flow. It **changes the
   presentation of past periods' cash-flow reports** (re-running an already-reported
   period moves those amounts from *Investing* to *Operating*; net change in cash is
   unaffected) — tell whoever consumes
   the reports, and check the rehearsal's before/after cash-flow for a closed year.
   `20260925100000_add_voided_on` backfills `voided_on` before adding its CHECK, `20260929000000` only replaces a
   trigger function, and `20260926000000` / `20260928000000` / `20261001000000` /
   `20261003000000` (index on `payment_allocations(payment_id)`), `20261005100000`
   (`audit_log.replayed` column) and `20261005200000` (two FK indexes) are additive.
   Fix the data by hand, mark the failed attempt as rolled back, and re-run. There
   is no host `node`/`npx` on the VM and `db` is not published, so run `resolve`
   **in the migrate image** — after pinning `MIGRATE_IMAGE` (*Operator commands on a
   CD-managed VM*; for the rehearsal, the NEW image you just ran) — with the same
   `DATABASE_URL` as the failed run:
   ```bash
   # rehearsal (scratch database):
   $COMPOSE run --rm --no-deps \
     -e DATABASE_URL="postgresql://accounting:${POSTGRES_PASSWORD}@db:5432/scratch?schema=public" \
     migrate node_modules/.bin/prisma migrate resolve --rolled-back <migration>
   # production (the live database — the service's own DATABASE_URL):
   $COMPOSE run --rm --no-deps migrate node_modules/.bin/prisma migrate resolve --rolled-back <migration>
   ```
   Without it the next `migrate deploy` refuses with `P3009` (failed migrations in
   the target database). Only deploy to production once the rehearsal applies
   cleanly.
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
7. **Metrics token out of tracked `prometheus.yml`:** if an operator pasted the
   `/metrics` bearer token into `monitoring/prometheus.yml` (older releases), drop
   that local edit **before** deploying — `git checkout -- monitoring/prometheus.yml`
   — or CD's `git checkout --detach` aborts on it; then put the token in
   `monitoring/secrets/metrics_token` (*Monitoring* step 2 below; *Metrics auth
   coupling* note). Prometheus only sees that file through the overlay's
   `monitoring/secrets` mount, which a Prometheus container created by an older
   release does not have — so once the file is written, **recreate Prometheus**
   with the monitoring overlay (third-party image, nothing to build, `--no-deps`
   leaves the api alone):
   ```bash
   $COMPOSE -f docker-compose.monitoring.yml up -d --no-build --no-deps prometheus
   ```
   and check the scrape: `$COMPOSE -f docker-compose.monitoring.yml exec prometheus
   promtool check config /etc/prometheus/prometheus.yml` is green and
   `/targets` shows `api` **UP**. Skipping this leaves Prometheus reading the old
   config until its next restart, after which the api target goes `down` and
   `ApiDown` fires.
8. **Recreate Caddy** — this release changes the `Caddyfile` (`/ready*` joins
   `/metrics*` in the edge 404) but not the `caddy` service definition, so the
   deploy's `up -d --no-build` leaves the old Caddy running with the old file and
   `/ready` stays **public** (see *Changed `Caddyfile` / `scripts/backup.sh`*).
   CD does it automatically (it recreates `caddy` whenever the running container's
   `/etc/caddy/Caddyfile` differs from the checked-out file — also on a re-run);
   on a VM-built deploy, or if in doubt, run the same check by hand (safe on a live
   VM — about a second of refused connections, certificates kept; a no-op when
   Caddy already has the file):
   ```bash
   $COMPOSE exec -T caddy cat /etc/caddy/Caddyfile | cmp -s - Caddyfile \
     || $COMPOSE up -d --no-build --no-deps --force-recreate caddy
   ```
   Verify from **outside** the VM: `curl -s -o /dev/null -w '%{http_code}\n'
   https://$DOMAIN/ready` → `404`, and the same for `/health` → `200`.
9. After the deploy: `/ready` is 200 **from inside** (*Health & shutdown* →
   *Edge exposure*), `$COMPOSE logs migrate` ends with
   `ensure-app-role: accounting_app role + grants are up to date`, and a login +
   one read works.

## Database roles (least privilege)

| Role | Used by | Privileges |
|---|---|---|
| `accounting` (`POSTGRES_USER`, owner) | `migrate`, `backup`, operators | owns the schema; DDL |
| `accounting_app` | `api` (`DATABASE_URL` in `docker-compose.prod.yml`) | `SELECT/INSERT/UPDATE` on all tables, `DELETE` **only** on the hard-delete allow-list (`sales_invoice_lines`, `purchase_bill_lines`, `sales_credit_note_lines`, `purchase_debit_note_lines`, `accounting_periods`, `idempotency_keys`, `refresh_tokens`), `USAGE/SELECT/UPDATE` on sequences; **no** TRUNCATE, **no** DDL, not superuser/createdb/createrole, owns nothing, no access to `_prisma_migrations`, INSERT/SELECT only on the append-only `audit_log` |

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
- **Host exposure:** in production **only Caddy publishes ports** (80/443). The
  base `docker-compose.yml` publishes the api (`127.0.0.1:3000`), Postgres
  (`127.0.0.1:5432`) and Redis (`127.0.0.1:6379`) for local dev;
  `docker-compose.prod.yml` removes all three (`ports: !reset []`), so nothing on
  the VM can reach the api around Caddy's headers, body cap and `/ready`/`/metrics`
  blocking, nor the database/Redis directly. The services still talk over the
  compose network (`db:5432`, `redis:6379`), and the `backup` sidecar and CD's
  deploy script never use host ports. Verify: `$COMPOSE config` shows `ports`
  only under `caddy`. Operator access goes through the containers:
  `$COMPOSE exec db psql -U accounting -d accounting`,
  `$COMPOSE exec redis redis-cli ping`. For a one-off host-side smoke/perf run or
  a host `psql`/`redis-cli`, add `-f docker-compose.hostport.yml` (opt-in, never in
  a real deploy; it re-publishes api/db/redis on loopback only, and applying it to
  a running `db`/`redis` recreates that container — a brief restart). On a live VM
  apply it to the one service you need — `$COMPOSE -f docker-compose.hostport.yml
  up -d --no-build --no-deps db` — and run the same `up -d --no-build --no-deps db`
  without it afterwards to close the port again (pin the images first if the
  service is `api`/`migrate` — *Operator commands on a CD-managed VM*). The overlay
  also sets the api's `TRUST_PROXY_HOPS` to **0** (a loopback-published api has no
  proxy in front, so trusting a hop would let a local client forge its `req.ip`);
  while the api runs under it, traffic that does come through Caddy shares Caddy's
  IP for the per-IP login ceiling — never leave the api on it on a VM serving users.
- **Edge exposure:** Caddy answers `404` for `/ready*` and `/metrics*` (dependency state and metrics are internal) — once the running `caddy` container has the current `Caddyfile`: after a deploy that changed it, recreate `caddy` (*Changed `Caddyfile` / `scripts/backup.sh`*; CD does it) or `/ready` stays public. The container healthcheck (`127.0.0.1:3000/ready`) and Prometheus (`api:3000/metrics`) bypass Caddy, so they are unaffected; external uptime probes use `https://$DOMAIN/health`. Check readiness from the VM with `$COMPOSE exec api node -e "require('http').get('http://127.0.0.1:3000/ready',r=>console.log(r.statusCode))"`.
- One-time caveat (AUDIT3-7, `20260926100000_auth_hardening`): the migration
  lowercases `users.email` and adds a unique index on `lower(email)`. It **aborts
  with a clear error listing the emails** if two accounts differ only by
  case/whitespace — nothing is applied (the check runs first). Resolve those
  accounts by hand (rename/tombstone one), mark the failed attempt — in the
  migrate image, after pinning `MIGRATE_IMAGE` (*Operator commands on a CD-managed
  VM*; no host `npx`, `db` is not published) — with
  `$COMPOSE run --rm --no-deps migrate node_modules/.bin/prisma migrate resolve --rolled-back 20260926100000_auth_hardening`,
  and re-run the deploy. Tokens now carry a `typ` claim: every access/refresh token issued
  before the deploy is rejected, so all users log in again once.
- One-time caveat: migration `20260705163429_scope_idempotency_keys_by_user`
  clears the `idempotency_keys` cache to add the NOT NULL `user_id` column. On
  the deploy that first applies it, a client retrying a write completed in the
  previous ~24h with the same `Idempotency-Key` re-executes instead of
  replaying — apply it in a low-traffic window.
- `SIGTERM` (e.g. `$COMPOSE stop api`) triggers a graceful Nest shutdown
  (idle keep-alive sockets close, in-flight requests finish within `stop_grace_period` = 45s, THEN Prisma/Redis disconnect).

## X-Forwarded-For / client IP trust (SEC-3)
Caddy (the TLS edge) **ignores any client-supplied `X-Forwarded-For` by default**
to prevent spoofing — it sets `X-Forwarded-For` to the real connecting client
before proxying to `api`. The app's `trust proxy` hop count (`TRUST_PROXY_HOPS`,
default **1 in production**, 0 elsewhere; `docker-compose.prod.yml` passes 1, while the
base `docker-compose.yml` alone — which publishes the api with no Caddy in front —
passes 0) makes `req.ip` the
right-most `X-Forwarded-For` entry — the one Caddy wrote — so the per-IP login
ceiling (`THROTTLE_LOGIN_IP_LIMIT`) and audit IPs use the true client address and
cannot be bypassed with a forged header. **If you add a CDN/LB in front of Caddy,
raise `TRUST_PROXY_HOPS` to the number of proxies** (and configure Caddy as below);
if the API is ever exposed without Caddy, set it to 0 (the opt-in
`docker-compose.hostport.yml` does exactly that for its loopback-published api).
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
leftmost-IP spoofing. Commit the `Caddyfile` change and deploy it; the running
Caddy picks it up only when recreated (*Changed `Caddyfile` / `scripts/backup.sh`*
— CD does it).

**Deploy-time verification:** against a deployed instance, hammer the login limit
from one source while rotating a forged `X-Forwarded-For`; it should still 429
(the forged header is ignored), confirming the real client IP is used.

## Rollback

**Roll back manually on the VM (below) — never by re-dispatching the CD workflow on an
older ref.** A `workflow_dispatch` run executes the workflow file *of the selected ref*:
an older tag runs that tag's older `cd.yml` and `scripts/deploy-remote.sh`, which lack
every deploy step added since (e.g. `stop api` before `migrate`, the content-based
`caddy` / `backup` recreate) — so it can start old code against the current schema or
leave containers on stale config. The manual steps below keep today's procedure
while pinning the older images (`ghcr.io/<owner>/<repo>[-migrate]:<prior-sha>`, still
in GHCR from that release's CD run).

1. **App-only rollback (no schema change):** redeploy the previous image tag/commit —
   check out the prior commit and export its `API_IMAGE` / `MIGRATE_IMAGE`
   (`ghcr.io/<owner>/<repo>[-migrate]:<prior-sha>`), then `pull` +
   `up -d --no-build` (or `up -d --build` for a VM-built image). Caddy/api/backup
   restart against the unchanged DB. Then run the `Caddyfile` / `scripts/backup.sh`
   compare-and-recreate lines (*Changed `Caddyfile` / `scripts/backup.sh`*): a manual
   checkout is not a CD run, and they recreate only what differs.
2. **Migrations are forward-only.** Rolling back the image does NOT undo a migration.
   If a bad migration shipped:
   a. Stop the API: `$COMPOSE stop api`.
   b. Prefer a **corrective forward migration** (a new migration that fixes the bad
      one) over editing history — never edit an already-applied migration.
   c. If data is corrupted, **restore from backup**: follow `backup-and-restore.md`
      (stop `api`, `migrate` **and `backup`** — so no dump of the half-restored
      database is taken — restore the latest good `pg_dump -Fc` into the `db` volume
      from a one-off `backup` container, then bring `api` and `backup` back up). Accept the data delta since that backup.
3. After any rollback, verify `/health` (200, from outside: `curl -s -o /dev/null -w '%{http_code}\n' https://$DOMAIN/health`)
   and `/ready` **from inside** the VM — externally Caddy answers `/ready` with `404` by design:
   `$COMPOSE exec api node -e "require('http').get('http://127.0.0.1:3000/ready',r=>console.log(r.statusCode))"` → `200`
   (DB + Redis reachable).

## Monitoring (optional)

An optional observability overlay ships in `docker-compose.monitoring.yml`
(Prometheus + Grafana + alertmanager + **Loki/Alloy log aggregation**).
The subsections below explain each piece; this checklist is the whole
activation, in order:

### Bring the stack up (checklist)

1. **On the VM, add to the `.env`** next to the compose files:

   ```bash
   GRAFANA_ADMIN_PASSWORD=<strong password>        # required
   METRICS_TOKEN=<openssl rand -hex 32>            # required in production (see step 2)
   ALERT_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...   # or ALERT_WEBHOOK_URL (see below)
   # ALERT_SLACK_CHANNEL=#alerts                   # optional override
   # ALERT_HEARTBEAT_URL=https://hc-ping.com/<uuid>  # optional dead-man's switch
   ```

2. **Give Prometheus the same token in an untracked file.** `monitoring/prometheus.yml`
   (tracked, no secret) reads the scrape bearer token from
   `credentials_file: /etc/prometheus/secrets/metrics_token`; the overlay mounts the
   git-ignored host dir `monitoring/secrets/` there read-only. Nothing tracked is
   edited, so CD's `git checkout --detach` is never blocked by operator config.
   Prometheus runs as `nobody` (uid/gid 65534), so the file must be readable by that
   uid — a plain `chmod 600` owned by your login user is **not** (the scrape then
   fails with `permission denied`):

   ```bash
   set -a; . ./.env; set +a
   (umask 077; printf '%s\n' "$METRICS_TOKEN" > monitoring/secrets/metrics_token)
   sudo chown 65534:65534 monitoring/secrets/metrics_token   # stays mode 600
   ```

   The file is re-read on every scrape: to rotate, change `METRICS_TOKEN` in `.env`,
   rewrite the file in place with `sudo` (it is owned by `65534` now, and `tee` keeps
   that owner and mode 600 — re-run the `chown` above if you ever recreate it):
   ```bash
   set -a; . ./.env; set +a
   printf '%s\n' "$METRICS_TOKEN" | sudo tee monitoring/secrets/metrics_token >/dev/null
   ```
   then recreate **only** the api so it picks up the new `METRICS_TOKEN` — on a
   CD-managed VM pin the deployed image first (*Operator commands on a CD-managed
   VM*; a bare `up -d api` would recreate it from a stale `accounting-api:local`
   and re-run `migrate` from a stale `accounting-api-migrate:local`):
   ```bash
   export API_IMAGE=$(docker inspect -f '{{.Config.Image}}' "$($COMPOSE ps -a -q api)")
   $COMPOSE up -d --no-build --no-deps api
   ```
   No Prometheus restart. **The overlay needs this file for the api scrape to succeed** — without it
   Prometheus still starts, but the api target is `down` (`unable to read
   authorization credentials`) and `ApiDown` fires.
   (`promtool check config`, by contrast, reports `FAILED … metrics_token: no such
   file` until the file exists — so a green check also proves the file is in place:
   `$COMPOSE -f docker-compose.monitoring.yml exec prometheus promtool check config /etc/prometheus/prometheus.yml`.)

3. **Start the overlay's services** (all third-party images — never `--build`).
   Name them, so the api/migrate/db are not touched (a bare `up -d` would also
   recreate `api`/`migrate`, from a stale `:local` image on a CD-managed VM):

   ```bash
   $COMPOSE -f docker-compose.monitoring.yml up -d --no-build --no-deps \
     prometheus alertmanager node-exporter loki alloy grafana
   ```

   CD keeps deploying without the monitoring overlay; its `up -d` does not touch
   these containers (they are not in its project files, and compose does not
   remove them without `--remove-orphans`).

4. **Confirm delivery is armed:** `$COMPOSE -f docker-compose.monitoring.yml logs alertmanager | head`
   must show `alert delivery ACTIVE (...)` — a `WARN: no ALERT_*_URL set`
   means step 1's variable didn't reach the container. Also confirm the scrape:
   `http://127.0.0.1:9090/targets` (via the tunnel in the next step) shows `api` **UP**.

5. **Open Grafana — via SSH tunnel.** Grafana (3001) and Prometheus (9090)
   bind to `127.0.0.1` on the VM on purpose (not exposed through Caddy):

   ```bash
   ssh -L 3001:127.0.0.1:3001 -L 9090:127.0.0.1:9090 <user>@<vm>
   ```

   Then browse `http://localhost:3001` (admin / `GRAFANA_ADMIN_PASSWORD`).
   The accounting dashboard and both datasources (Prometheus, Loki) are
   auto-provisioned; logs live under **Explore → Loki**.

6. **Fire-drill the alerting** (do this once — an alert channel you've never
   seen a message in is not activated): `$COMPOSE stop api`, wait ~3
   minutes, confirm `ApiDown` lands in the channel, then
   `$COMPOSE start api` and confirm the resolved notice.

7. **Create the external uptime check** (OPS-OBS-5): a free UptimeRobot /
   healthchecks.io / Better Stack probe on `https://$DOMAIN/health`, 1-minute
   interval — see the failure-domain note at the end of this section.

Steps 1–6 are one sitting on the VM; step 7 is a two-minute signup anywhere.

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

> **Metrics auth coupling (OPS-OBS-4):** in production `METRICS_TOKEN` MUST be set on
> the api AND `monitoring/secrets/metrics_token` MUST hold the same value (step 2 above;
> never paste the token into `monitoring/prometheus.yml`). `/metrics` is fail-closed:
> with the token unset it answers `401` in production, a mismatched file gets `401`, and a
> missing/unreadable file fails the scrape before it is sent — each way `up == 0` and the
> `ApiDown` alert fires. The compose api always runs `NODE_ENV=production`, so this
> applies to every stack built from these files. **Upgrading a VM whose
> `prometheus.yml` still has the token pasted in (older releases):** do this *before*
> the deploy of this release — CD's `git checkout --detach` under `set -eu` aborts on
> that local edit because this release changes the file: `git checkout --
> monitoring/prometheus.yml` (drops the local edit), then after the checkout create
> `monitoring/secrets/metrics_token` as in step 2 (the directory arrives with the new
> commit; `mkdir -p monitoring/secrets` if you create the file first), and recreate
> Prometheus so it gains the secrets mount:
> `$COMPOSE -f docker-compose.monitoring.yml up -d --no-build --no-deps prometheus`
> (audit-3 checklist step 7).
>
> **`backup_metrics` volume:** the overlay no longer declares it `external` with a
> hard-coded `accounting-api_backup_metrics` name; it merges into the prod file's
> volume of the same key, i.e. `<project>_backup_metrics` for whatever the checkout
> directory (compose project) is called. An existing install in a directory named
> `accounting-api` keeps using the same volume — nothing to do. A project name that
> differs from the directory (`COMPOSE_PROJECT_NAME` or `-p`) yields a differently-named
> volume (`<that name>_backup_metrics`); that is harmless — the next backup run
> rewrites the metrics into it, and the old volume can be removed. (If you had created
> that volume by hand with `docker volume create`, compose warns it "was not created
> by Docker Compose" but uses it; to silence that, `docker volume rm` it while the
> `backup`/`node-exporter` containers are stopped — it only holds the last backup's
> textfile metrics, rewritten on the next backup run.)

### Activate alert delivery (OPS-OBS-1)

Delivery is **env-driven** — no YAML editing. Set ONE variable in the `.env` next
to the compose files and recreate alertmanager (a plain `restart` keeps the old
environment):
`$COMPOSE -f docker-compose.monitoring.yml up -d --no-build --no-deps alertmanager`.

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
> For a staging or local machine only — **never on the CD-managed production VM**
> (these commands start `api`/`migrate` from whatever `API_IMAGE`/`MIGRATE_IMAGE`
> resolve to; there, use *Operator commands on a CD-managed VM*).

Don't edit the committed `Caddyfile` (it would dirty the repo and risk shipping a
non-prod TLS setting). Instead either:
- **Skip Caddy:** smoke-test `db`+`migrate`+`api` only and curl `http://127.0.0.1:3000/health`
  (`docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.hostport.yml up -d db migrate api`
  — the prod overlay alone publishes nothing but Caddy; spelled out rather than
  `$COMPOSE` on purpose: it adds the local-only `hostport` overlay, never used on a VM); or
- **Throwaway internal TLS:** copy the Caddyfile with `tls internal` inserted **inside the
  site block**, right after its first line (`{$DOMAIN} {`). Do not append it after the
  closing `}`: Caddy then refuses to start with "parsed 'tls' as a site address". Mount
  the copy via a one-off override file — e.g. `awk 'NR==1{print; print "\ttls internal"; next}1' Caddyfile > /tmp/Caddyfile.staging`
  (check it with `docker run --rm -e DOMAIN=localhost -v /tmp/Caddyfile.staging:/etc/caddy/Caddyfile:ro <the caddy image from docker-compose.prod.yml> caddy adapt --config /etc/caddy/Caddyfile`), then a small `docker-compose.staging.yml` that remaps `caddy.volumes` to `/tmp/Caddyfile.staging:/etc/caddy/Caddyfile:ro`, and add `-f docker-compose.staging.yml` to the up command. `DOMAIN=localhost`, then `curl -k https://localhost/health`.

### Activate offsite + encrypted backups (OPS-DB-1)

`scripts/backup.sh` writes a local `pg_dump` by default. To also encrypt and ship
offsite, set env on the `backup` service (all optional; unset = local-only, as today):
- `BACKUP_AGE_RECIPIENT` — an [age](https://age-encryption.org) recipient public key;
  the dump is encrypted to `*.dump.age` before leaving the host. If encryption fails
  (or `age` is missing) that run's plaintext dump is **not** shipped offsite (WARN
  `not shipped offsite: encryption failed`); it stays local-only until retention
  prunes it — only `.dump.age` files ever leave the host while a recipient is set.
- **S3:** `BACKUP_S3_BUCKET` (e.g. `my-bucket/accounting`) + AWS creds (`AWS_ACCESS_KEY_ID`/
  `AWS_SECRET_ACCESS_KEY`/`AWS_DEFAULT_REGION`) for `aws`, or an `rclone` remote config.
- **rsync:** `BACKUP_RSYNC_TARGET` (e.g. `user@host:/backups/`) with SSH access.

The default `backup` image (`postgres:16`) does NOT include `age`/`aws`/`rclone`/`rsync`.
Provide them via a custom backup image (recommended) or a bind-mount; the script logs a
clear WARN and keeps the local dump if a configured tool is missing (a missing `age`
with a recipient set also skips the offsite upload, as above). Restore: decrypt
with `age -d -i <key> file.dump.age > file.dump`, then follow `backup-and-restore.md`.

Each run writes `backup_offsite_configured` and `backup_last_offsite_success_timestamp_seconds`
(updated only by a successful upload; `0` = never shipped) next to the local
`backup_last_success_timestamp_seconds`. **`OffsiteBackupStale`** fires when offsite is
configured but nothing shipped for 26h — a failing upload (expired credentials, missing tool,
encryption failure) is no longer hidden behind a fresh local dump. `BackupStale` also fires
when the metric is missing entirely.

## CD pipeline (OPS-CI-1)

`.github/workflows/cd.yml` is **manual** (`workflow_dispatch`) — it does NOT run on push.
To release: GitHub → **Actions** → **CD** → **Run workflow** → pick the **tag** (or branch)
from the ref dropdown → **Run**. It builds/deploys exactly the selected ref — using
that ref's own `cd.yml`, so it is for releasing forward only; to go back to an older
release follow *Rollback* (manual), never dispatch CD on the older ref.
0. **CI gate** — the run fails immediately unless `ci.yml` has a **successful
   push-to-`main` run for the exact commit SHA** being released (Actions API query with
   `event=push&branch=main`). A green PR run for an unmerged head does not qualify, so
   only commits that landed on `main` (or tags cut from them) can be released.
   **Environment hardening (GitHub settings):** the `deploy` job declares
   `environment: production`. Create that GitHub **Environment** holding the
   `DEPLOY_SSH_*` / `DEPLOY_PATH` secrets, with a *deployment branch/tag policy*
   allowing only `main` and your release tag pattern (e.g. `v*`) and, optionally,
   required reviewers. Environment secrets are only released to runs whose ref
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
2. **Deploy (optional, gated)** — runs ONLY if the repository **variable**
   `DEPLOY_ENABLED` is `true` (Settings → Secrets and variables → Actions →
   *Variables*). It is a variable, not a secret check, on purpose: `vars` is allowed
   in a job-level `if:` and visible to every job, while a job probing a secret only
   sees Environment secrets if it declares that Environment itself — a probe
   without it would silently skip the deploy once the secrets moved into
   `production`. Add `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_KEY`,
   `DEPLOY_PATH` (repo dir on the VM) as **`production` Environment secrets**, then
   set `DEPLOY_ENABLED=true`. With the variable set but a secret missing, the SSH
   step fails loudly (it never skips). The remote commands are the committed
   `scripts/deploy-remote.sh` (sent by `appleboy/ssh-action`'s `script_path` from a
   checkout of the released commit, and shellcheck-linted by CI). Over SSH it checks the repo out at the released SHA (if
   `DEPLOY_PATH` is a git checkout), exports `API_IMAGE` / `MIGRATE_IMAGE` = the
   immutable `:<sha>` images, and runs `compose pull`, `compose stop api` (the old api
   must not run against the new schema) and `compose up -d --no-build` (migrate, then
   the new api). Finally it force-recreates `caddy` / `backup` when the file the
   running container reads differs from the checked-out `Caddyfile` /
   `scripts/backup.sh` (*Changed `Caddyfile` / `scripts/backup.sh`* — content-based,
   so a re-run converges and an unchanged file recreates nothing).
   The VM must be logged in to GHCR if the packages are private
   (`docker login ghcr.io` with a `read:packages` token) and its `.env` must contain
   `APP_DB_PASSWORD`. Until `DEPLOY_ENABLED` is `true`, CD only publishes.

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
On push/PR to `main`, CI runs five jobs: `verify` (Prisma generate + typecheck +
lint + unit + e2e with coverage), `audit` (`npm run audit:ci`, fails on a
moderate-or-higher advisory in prod deps), `shellcheck` (every `scripts/**/*.sh`,
incl. `scripts/deploy-remote.sh` — the commands CD runs on the VM), `docker`
(production image build + Trivy HIGH/CRITICAL vulnerability scan, unfixed ignored,
`exit-code 1`) and `docker-migrate` (the same Trivy scan of the migrate image, the
Dockerfile `build` stage — like the runtime image it ships no npm/npx, so run the
Prisma CLI in it as `node_modules/.bin/prisma …`). The migrate image carries the full
lockfile install, **dev dependencies included**, so its Trivy scan can go red on a
dev-only advisory that `audit` (prod deps only) does not flag. CD's `ci-gate` needs the
whole run green, so a failing scan of either image blocks releases until the base
image (or the affected dependency, e.g. via a `package.json` `overrides` bump) is bumped.
Recommended next step: enable branch protection on `main` requiring the `verify`
and `audit` checks to pass before merge.
