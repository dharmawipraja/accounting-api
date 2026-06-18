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
  `/ready`) return `503`. The container can even look "healthy" (the healthcheck
  only hits `/health`).
- **Cause:** Redis is not reachable. The rate limiter is **fail-closed**: when the
  Redis storage is unavailable the throttler guard turns the error into a `503`
  ("Rate limiter unavailable") instead of silently disabling limiting. `REDIS_URL`
  is **required in dev & prod** (tests run in-memory).
- **Fix:** Start Redis and point `REDIS_URL` at it (default
  `redis://localhost:6379`; the prod compose stack ships a `redis` service). Then
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

- **Symptom:** A known endpoint returns `404`, e.g. `POST /journals` 404s.
- **Cause:** Missing the **`/v1`** prefix. The API uses URI versioning with
  `defaultVersion: '1'`, so every business route is served under `/v1`
  (`/v1/journals`, `/v1/accounts`, ...).
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

### Request returns 408

- **Symptom:** A request returns `408` ("Request timed out").
- **Cause:** The handler exceeded `REQUEST_TIMEOUT_MS` (default **30000 ms / 30s**).
  A per-request timeout interceptor caps handler duration and returns a clean `408`
  envelope (probes `/health`, `/ready`, `/metrics` are exempt).
- **Fix:** Investigate the slow handler (usually a slow query or a lock wait). If
  you raise `REQUEST_TIMEOUT_MS`, keep it **≤ the 30s server `requestTimeout`** —
  otherwise the underlying socket is cut before the `408` envelope can be returned,
  and the client just sees a dropped connection.

---

## Dependencies & tooling

### `npm audit` advisories, and `npm audit fix --force` wants to downgrade `@nestjs/testing`

- **Symptom:** `npm audit` flags transitive advisories; `npm audit fix --force`
  proposes breaking changes such as downgrading `@nestjs/testing`.
- **Cause:** The affected packages are **transitive** deps. They're already pinned
  to patched versions via the `overrides` block in `package.json`
  (`multer`, `form-data`, `@hono/node-server`, `js-yaml`). `--force` ignores that
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
