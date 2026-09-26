# Troubleshooting Runbook

Common gotchas a developer actually hits on this codebase, each as
**Symptom → Cause → Fix**. See also [`./local-development.md`](./local-development.md)
for first-run setup, [`./testing.md`](./testing.md) for the test tiers,
[`./database-and-migrations.md`](./database-and-migrations.md) for Prisma/migration
mechanics, and [`./deploy.md`](./deploy.md) for production deploys.

> Quick triage order: `npm run typecheck` is the source of truth for types,
> `/ready` names a failed dependency, and the global error filter returns a clean
> JSON envelope with the real status code — read it before guessing.

---

## Build & types

### Editor shows "Property 'role' does not exist on type ..." or "X is not exported from @prisma/client"

- **Symptom:** Red squiggles in the editor referencing a model field or enum you
  just added to `prisma/schema.prisma` (e.g. `account.role`, `AccountRole`), yet
  the code looks correct.
- **Cause:** The generated Prisma client in `node_modules/.prisma` is stale. The
  editor's TypeScript language server is type-checking against the *old* generated
  types, which don't yet include your schema change.
- **Fix:** Regenerate the client, then trust the CLI over the editor:
  ```bash
  npm run db:generate    # prisma generate
  npm run typecheck      # tsc --noEmit — this is the source of truth
  ```
  `typecheck` will exit 0 once the client is regenerated even while the editor
  still shows red. Restart the TS server in your editor to clear the stale squiggles.

> Any change to `prisma/schema.prisma` requires `npm run db:generate` (or a
> `db:migrate`, which generates as part of the flow). See
> [`./database-and-migrations.md`](./database-and-migrations.md).

---

## Tests

### e2e tests fail to start, "could not start container", or hang on `beforeAll`

- **Symptom:** Every e2e suite errors out early (often in `startTestDb()` /
  `beforeAll`), with messages about not being able to start or reach a container,
  or the run just hangs.
- **Cause:** Docker is not running. The e2e tier uses **Testcontainers** to spin up
  a throwaway `postgres:16` per suite and applies migrations on every run; with no
  Docker daemon there is nothing to start.
- **Fix:** Start Docker Desktop (or your daemon) and confirm it's up
  (`docker info`), then re-run `npm run test:e2e`. Also ensure nothing else is
  holding the ports Testcontainers needs. Unit tests (`npm test`) need **no**
  Docker — if only e2e fails, suspect Docker first.

### A suite fails under `npm run verify` but passes when run alone

- **Symptom:** The full `npm run verify` (or `test:e2e:cov`) reports a failing e2e
  suite, but running that suite by itself is green.
- **Cause:** Environmental Testcontainers contention under load (container
  start/teardown timing, host resource pressure) — a flaky environment, **not** a
  code bug.
- **Fix:** Re-run the suite in isolation:
  ```bash
  npm run test:e2e -- <suite-name-or-path>
  ```
  Treat it as a real failure **only if it also fails alone**. If it's green in
  isolation, it was environmental — re-run `verify`. See
  [`./testing.md`](./testing.md) for the two-tier setup and single-spec syntax.

---

## Runtime / boot

### App boots but every business request returns 503 (and `/ready` returns 503)

- **Symptom:** The process starts and `/health` is 200, but business routes (and
  `/ready`) return `503`. In the prod compose stack the api container turns
  **unhealthy** (its healthcheck probes `/ready`); anything probing only `/health`
  still looks fine.
- **Cause:** Redis is not reachable. The rate limiter is **fail-closed**: when the
  Redis storage is unavailable the throttler guard turns the error into a `503`
  ("Rate limiter unavailable") instead of silently disabling limiting. `REDIS_URL`
  is **required in dev & prod** (tests run in-memory).
- **Fix:** Start Redis and point `REDIS_URL` at it (default
  `redis://localhost:6379`; the prod compose stack ships a `redis` service, not
  published on the host — check it with
  `docker compose -f docker-compose.yml -f docker-compose.prod.yml exec redis redis-cli ping`). Then
  check `/ready` — it pings the DB and Redis and the `503` message **names the
  failed dependency** ("Database unavailable" / "Redis unavailable"). See the
  Redis prerequisite note in [`./deploy.md`](./deploy.md).

### App won't boot: "Invalid environment configuration: ..."

- **Symptom:** The process exits at startup throwing
  `Invalid environment configuration: ...` with a list of validation errors.
- **Cause:** `src/config/env.validation.ts` validates the environment **fail-fast**
  at boot. Common triggers:
  - `NODE_ENV` not one of `development | production | test`.
  - `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` shorter than **32 chars**.
  - Missing `DATABASE_URL`, `JWT_ACCESS_TTL`, or `JWT_REFRESH_TTL`.
  - Missing `REDIS_URL` outside the `test` environment (it's only optional under
    `NODE_ENV=test`).
  - Out-of-range numerics (e.g. `PORT` outside 1–65535) or a non-`true|false`
    `ENABLE_SWAGGER`.
- **Fix:** Read the error — it lists the offending vars — and fix the env. Copy
  [`.env.example`](../../.env.example) and fill real values
  (`.env` / `.env.development` per the loader described in
  [`./local-development.md`](./local-development.md)).

### Prod image crashes: `Cannot find module '/app/dist/main.js'`

- **Symptom:** The production container exits immediately with
  `Cannot find module '/app/dist/main.js'` (or a similar `dist/main`-not-found).
- **Cause:** `nest build` emits to **`dist/src/main.js`**, not `dist/main.js`
  (`outDir: ./dist` combined with nest-cli's `sourceRoot: src` nests output under
  `dist/src/`). A path of `dist/main` will never resolve.
- **Fix:** Use **`dist/src/main`**. This is already corrected in the repo — the
  Dockerfile `CMD ["node", "dist/src/main.js"]` and the `start:prod` script
  (`node dist/src/main`) both point there. If you add a new entrypoint or compose
  command, mirror that path.

---

## HTTP requests

### 404 on a business route that should exist

- **Symptom:** A known endpoint returns `404`, e.g. `POST /ledger/journal-entries` 404s.
- **Cause:** Missing the **`/v1`** prefix. The API uses URI versioning with
  `defaultVersion: '1'`, so every business route is served under `/v1`
  (`/v1/ledger/journal-entries`, `/v1/ledger/accounts`, ...).
- **Fix:** Prefix the path with `/v1`. The operational probes are the exception —
  `/health`, `/ready`, and `/metrics` opt out via `VERSION_NEUTRAL` and stay at the
  **root** (no `/v1`). The frontend base URL should already include `/v1`.

### 422 on a write that worked before

- **Symptom:** A create/money-mover that used to succeed now returns `422`
  ("Idempotency-Key header is required" or "Idempotency-Key must be ...").
- **Cause:** Covered write handlers (money-movers and invoice/bill/payment creates)
  now **require** an `Idempotency-Key` header via the global idempotency
  interceptor. A missing key, or a key that doesn't match the validation pattern
  `^[A-Za-z0-9._:-]{1,128}$` (1–128 chars, that character set), is rejected with a
  `422` before the handler runs.
- **Fix:** Send a valid `Idempotency-Key` header (a UUID works) on each such write.
  Note the *other* `422` from the same system is a **conflict**, not a missing
  header: reusing one key on a different endpoint or with a different request body
  is rejected ("already used for a different endpoint" / "with a different request
  body") — that's a client bug (don't reuse a key for a different operation), not a
  missing-header issue.

### Posting an invoice/bill fails 422 with `details.taxAccountId` (legacy tax code)

- **Symptom:** A draft invoice/bill that applies a tax code created **before** the
  audit-3 release fails on `POST …/:id/post` (and new tax-code creates with the same
  account fail) with `422 VALIDATION_FAILED`, `details: { taxAccountId, reason }`,
  `reason` one of `NOT_POSTABLE`, `SYSTEM_ROLE`, `NORMAL_BALANCE`, `SUBTYPE`.
- **Cause:** The tax-code account rule (`src/tax/tax-account-rule.ts`) is enforced on
  create **and re-checked inside every document post**: the account must be postable,
  hold no system role, and match the kind — `PPN_INPUT`/`PPH_PREPAID` need a
  `DEBIT`-normal `TAX_RECEIVABLE` account, `PPN_OUTPUT`/`PPH_PAYABLE` a `CREDIT`-normal
  `TAX_PAYABLE` one. Older codes were not checked, and a tax code's account cannot be
  changed by `PATCH`. The seeded codes conform; hand-made ones may not.
- **Find them (read-only, run as the owner or `accounting_app`):**
  ```sql
  SELECT * FROM (
    SELECT t.id, t.code, t.kind, t.is_active,
           a.code AS account_code, a.name AS account_name,
           a.role, a.subtype, a.normal_balance, a.is_postable,
           CASE
             WHEN NOT a.is_postable THEN 'NOT_POSTABLE'
             WHEN a.role IS NOT NULL THEN 'SYSTEM_ROLE'
             WHEN a.normal_balance::text <> CASE WHEN t.kind::text IN ('PPN_INPUT', 'PPH_PREPAID')
                                                THEN 'DEBIT' ELSE 'CREDIT' END THEN 'NORMAL_BALANCE'
             WHEN a.subtype::text <> CASE WHEN t.kind::text IN ('PPN_INPUT', 'PPH_PREPAID')
                                         THEN 'TAX_RECEIVABLE' ELSE 'TAX_PAYABLE' END THEN 'SUBTYPE'
           END AS reason
    FROM tax_codes t JOIN accounts a ON a.id = t.tax_account_id
    WHERE t.deleted_at IS NULL
  ) v WHERE reason IS NOT NULL ORDER BY code;
  ```
  Drafts that still reference them (replace the list with the ids found above):
  ```sql
  SELECT 'sales_invoice' AS doc, d.id, d.date FROM sales_invoices d
  WHERE d.status = 'DRAFT' AND d.deleted_at IS NULL AND EXISTS (
    SELECT 1 FROM sales_invoice_lines l
    WHERE l.sales_invoice_id = d.id AND l.tax_code_ids && ARRAY['<tax-code-id>', '…']::text[])
  UNION ALL
  SELECT 'purchase_bill', d.id, d.date FROM purchase_bills d
  WHERE d.status = 'DRAFT' AND d.deleted_at IS NULL AND EXISTS (
    SELECT 1 FROM purchase_bill_lines l
    WHERE l.purchase_bill_id = d.id AND l.tax_code_ids && ARRAY['<tax-code-id>', '…']::text[]);
  ```
- **Fix (through the API — never edit accounts/tax codes in SQL):**
  1. If no conforming account exists, create one (`POST /v1/ledger/accounts`: postable,
     no role, `subtype` `TAX_RECEIVABLE` + `normalBalance` `DEBIT` for input VAT /
     prepaid PPh, `TAX_PAYABLE` + `CREDIT` for output VAT / withheld PPh).
  2. Create a replacement tax code on it (`POST /v1/tax/codes`, a new `code`, same
     `kind`/`rate`).
  3. Deactivate the old code (`POST /v1/tax/codes/:id/deactivate`) so it cannot be
     applied again. Posted documents keep their already-posted journal lines; nothing
     historical changes. Any balance sitting on the old account can be moved with a
     `MANUAL` journal if the accountant wants it on the new one.
  4. Re-`PATCH` each draft from the second query with `lines` that use the new tax code
     id, then post it.

### Request returns 408

- **Symptom:** A request returns `408` ("Request timed out").
- **Cause:** The handler exceeded `REQUEST_TIMEOUT_MS` (default **35000 ms / 35s**).
  A per-request timeout interceptor caps handler duration and returns a clean `408`
  envelope (probes `/health`, `/ready`, `/metrics` are exempt).
- **Escalation order (deliberate):** DB `statement_timeout` (30s, genuinely aborts
  the query) → `REQUEST_TIMEOUT_MS` 408 (35s) → server `requestTimeout` socket cut
  (40s). Keep that ordering if you tune any of them: the RxJS 408 only stops
  *observing* the handler — the underlying query keeps running unless the DB kills
  it, so the DB timeout must stay the shortest.
- **A 408 does NOT mean the write failed.** The handler may still complete after
  the response. Clients must retry with the **same** `Idempotency-Key` (replay or
  409-then-replay), never a fresh one — a fresh key can duplicate the write.
- **Audit:** a 408'd mutating request still writes exactly **one** `audit_log` row
  with `status_code = 408` (AuditInterceptor is registered outermost, before the
  timeout interceptor). If the handler later commits, the 408 row is all you get —
  correlate by `request_id` with the api logs.
- **Fix:** Investigate the slow handler (usually a slow query or a lock wait).

### Same-key retry keeps returning 409 "committed its write, but its response is unavailable"

- **Symptom:** A covered write returned `500`/`408`/network error; every retry
  with the same `Idempotency-Key` now returns `409 CONFLICT` with
  `details.committed: true`.
- **Cause:** By design. Every business write runs in `PrismaService.transaction()`,
  which marks the request's `idempotency_keys.committed_at` as the **last statement
  inside the transaction** — so the mark exists iff the write committed. The
  first request's write committed, but recording its response (`complete()`)
  failed, or the process died before it could. A committed key is never
  released and never stale-reclaimed, so the retry cannot re-execute the write
  (which would duplicate an invoice/payment/journal entry).
- **Fix:** Nothing to repair — the write is in the database. The client should
  reload the resource (list by partner/date/description) instead of retrying.
  To inspect: `SELECT * FROM idempotency_keys WHERE key = '<key>'` → `committed_at`
  set, `response`/`completed_at` NULL. Such rows expire with the completed-key
  purge (`IDEMPOTENCY_COMPLETED_TTL_MS`, counted from `committed_at`).
- **Dev note:** A raw `$transaction(` anywhere in `src/` (outside
  `prisma.service.ts`) is an ESLint error — it would skip the committed mark.
  Use `this.prisma.transaction(fn, opts)`.

### 409 CONFLICT with `details.retryable: true`

- **Symptom:** A write returns `409 CONFLICT`, message "…conflicted with a
  concurrent transaction and was rolled back; retry it", `details.retryable: true`.
- **Cause:** Postgres aborted the transaction with a deadlock (`40P01`),
  serialization failure (`40001`; Prisma `P2034`), lock timeout (`55P03`), or a
  statement cancelled by `statement_timeout` (`57014` query_canceled — surfaces
  as Prisma `P2010` for raw queries, `P2039` for model queries); or the
  interactive transaction ran past `maxWait`/`timeout` (Prisma `P2028`).
  Occasional occurrences under contention are expected; the filter logs a
  warning (not Sentry). A recurring `57014`/`P2028` on a report GET means the
  query is too heavy for the 30s DB budget (report snapshot tx: 5s wait + 25s)
  — narrow the range or look at the query plan.
- **Fix:** The client retries with the same `Idempotency-Key` (the aborted tx
  committed nothing and its key was released). If it recurs for one flow, look
  for inconsistent lock ordering — e.g. payment post/void lock allocation
  targets in ascending document-id order (`inLockOrder` in `payment-targets.ts`)
  precisely so opposite-order allocations queue instead of deadlocking.

---

## Dependencies & tooling

### `npm audit` advisories, and `npm audit fix --force` wants to downgrade `@nestjs/testing`

- **Symptom:** `npm audit` flags transitive advisories; `npm audit fix --force`
  proposes breaking changes such as downgrading `@nestjs/testing`.
- **Cause:** The affected packages are **transitive** deps. They're already pinned
  to patched versions via the `overrides` block in `package.json`
  (`multer`, `form-data`, `@hono/node-server`, `hono`, `deepmerge-ts`, `mysql2`,
  `valibot`, `fast-uri`, `qs`, `body-parser` — mostly the `prisma` CLI's tree, which
  counts as prod because `@prisma/client` peers on it). `--force` ignores that
  intent and tries to "fix" by yanking direct deps to older majors.
- **Fix:** Do **not** run `--force`. Resolve advisories by adding/adjusting an
  entry in the `package.json` `overrides` block, then re-check with `npm audit`
  (CI uses `npm run audit:ci` = `npm audit --omit=dev --audit-level=moderate`,
  which fails on a moderate-or-higher advisory in prod deps). After any dependency
  change, re-run `npm audit` to confirm it's clean.

---

## Observability

### Swagger `/docs` returns 404 in production

- **Symptom:** `/docs` works locally but 404s on the production deployment.
- **Cause:** Swagger is **off by default in production**. The bootstrap mounts
  `/docs` only when `NODE_ENV !== 'production'` **or** `ENABLE_SWAGGER === 'true'`.
- **Fix:** Set `ENABLE_SWAGGER=true` on the prod service to expose `/docs` (it
  reveals the full route/DTO surface — opt in deliberately). For a DB-free spec
  artifact instead, use `npm run openapi:export`.

### `/ready` or `/metrics` returns 404 from outside

- **Symptom:** `https://$DOMAIN/ready` (or `/metrics`, `/metrics/...`) returns `404`.
- **Cause:** Intended. The Caddyfile blocks `/ready*` and `/metrics*` at the edge;
  only `/health` is public. Healthchecks and Prometheus reach `api:3000` directly.
- **Fix:** Probe readiness from inside the network (see deploy.md "Edge exposure").

### `migrate` fails: "APP_DB_PASSWORD / POSTGRES_PASSWORD must be URL-safe"

- **Cause:** The password contains a character outside `A-Z a-z 0-9 . _ ~ -`. Compose
  embeds it unencoded in a `DATABASE_URL` (api / migrate / backup), which would
  break. `migrate` checks both (`ensure-app-role.js --check-only`) before
  `prisma migrate deploy`.
- **Fix:** Generate a new one (`openssl rand -hex 24`), put it in `.env`, redeploy
  (`migrate` re-sets the role password). Changing `POSTGRES_PASSWORD` on an existing
  volume also needs `ALTER ROLE accounting PASSWORD '…'` first — the owner password
  lives in the data volume (step-by-step: `deploy.md` → *Rotate `POSTGRES_PASSWORD`
  (owner) on an existing volume*).

### The `X-Request-Id` I sent is not echoed back / not in `audit_log.request_id`

- **Cause:** Intended. The trace id (`X-Request-Id` response header, error
  `traceId`, `audit_log.request_id`, log `req.id`) is always a server-generated UUID.
  A safe-shaped inbound value (`^[\w.-]{1,128}$`) is kept only as the
  `clientRequestId` log field and `audit_log.client_request_id`; anything else is
  dropped.
- **Fix:** Search logs/audit by `clientRequestId` / `client_request_id` for the
  caller's id, or by the response header for the server id.

### `/metrics` returns 401

- **Symptom:** A Prometheus scrape of `/metrics` gets `401` (and the `ApiDown`
  alert may false-fire).
- **Cause:** `METRICS_TOKEN` is set, so `/metrics` is gated by a bearer-token guard
  (constant-time compared). A scrape without the matching
  `Authorization: Bearer <token>` is rejected. (In production, the guard is
  **fail-closed**: if `METRICS_TOKEN` is *unset*, `/metrics` 401s rather than
  exposing metrics openly; dev/test allow it for convenience.)
- **Fix:** Give the scraper the matching bearer token. Keep the api's
  `METRICS_TOKEN` and `monitoring/prometheus.yml`'s
  `authorization.credentials` in sync — see the metrics-auth coupling note
  (OPS-OBS-4) in [`./deploy.md`](./deploy.md).

---

## Other gotchas worth knowing

### Rate-limited: 429 vs 503

- **Symptom:** A burst of requests starts returning `429`, or every throttled
  route returns `503`.
- **Cause:** `429` is a real limit hit (you exceeded `THROTTLE_LIMIT` /
  `THROTTLE_LOGIN_LIMIT` / `THROTTLE_REFRESH_LIMIT`). `503` from the same guard
  means the **Redis store is unavailable** (fail-closed — see the 503 boot gotcha
  above). The login throttle keys per **submitted email** (not IP), so a forged
  `X-Forwarded-For` can't restore a fresh budget.
- **Fix:** For `429`, back off or raise the relevant `THROTTLE_*` limit. For `503`,
  fix Redis connectivity.

### `db:migrate` / `db:reset` / `db:studio` seem to ignore your env

- **Symptom:** These scripts hit a different database than your running app, or
  fail to find `DATABASE_URL`.
- **Cause:** The `db:*` scripts run Prisma through `dotenv -e .env.development`, so
  they always load `.env.development` regardless of your shell env. They target the
  dev database, not test/prod.
- **Fix:** Put the dev `DATABASE_URL` in `.env.development`. Test uses ephemeral
  Testcontainers (no `.env.test`); prod env is injected by docker compose (no
  `.env.production`). See [`./database-and-migrations.md`](./database-and-migrations.md)
  and the loader notes in [`.env.example`](../../.env.example).

### A migration aborts: "… migration aborted — existing data violates new invariants / references missing journal entries"

- **Symptom:** `prisma migrate deploy` (or the `migrate` container) fails on
  `20260926300000_ledger_integrity` or `20260927000000_journal_link_fks` with a
  `RAISE EXCEPTION` listing counts/ids (unbalanced posted entries, orphaned
  `closing_entry_id` / `reversal_of_id` / `reversed_by_id`, …).
- **Cause:** The migration's pre-check found rows that the new CHECK/FK/trigger
  would reject. It deliberately repairs nothing.
- **Fix:** Correct the listed rows by hand (as the DB owner). The pre-check is
  the migration's first statement, so nothing was applied, but Prisma records the
  migration as failed: mark it with
  `npx prisma migrate resolve --rolled-back <migration_name>`, then re-run
  `prisma migrate deploy`.

### `migrate dev` says `20260926300000_ledger_integrity` "was modified after it was applied"

- **Symptom:** A local dev DB refuses to migrate, reporting a checksum mismatch
  on `20260926300000_ledger_integrity`.
- **Cause:** That DB applied an earlier draft of the migration (before the
  `posted_xid` line guard was folded in).
- **Fix:** Dev only: `npm run db:reset` (**destroys the dev DB**) and re-seed. See
  [`./database-and-migrations.md`](./database-and-migrations.md).
