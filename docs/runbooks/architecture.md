# Architecture Orientation

How this codebase is organized and the invariants that hold it together. This is
the developer's map: read it to understand *where* things live and *why* the
non-obvious patterns exist.

- For accounting concepts (DPP, PPN/PPh, control accounts, fiscal year, the close),
  see [`./domain-glossary.md`](./domain-glossary.md).
- For coding rules (naming, DTOs, money serialization, test conventions), see
  [`./conventions.md`](./conventions.md).
- For the schema, migrations workflow, and DB constraints, see
  [`./database-and-migrations.md`](./database-and-migrations.md).

---

## 1. Stack & layout

- **NestJS 11** (Express platform) — modules under `src/`, one per bounded concern.
- **Prisma 7** with the `adapter-pg` driver pattern, wrapped by a client extension
  (`src/common/prisma/soft-delete.extension.ts`); reach the DB through
  `PrismaService.client`, never the raw `PrismaClient`.
- **PostgreSQL 16** — the source of truth; several invariants live in SQL
  (`FOR UPDATE`/`FOR SHARE`, advisory locks, one-sided CHECK on journal lines,
  deferred balance + posted-entry immutability triggers, RESTRICT FKs,
  append-only audit trigger — see `database-and-migrations.md`).
- **Redis 7** — throttler storage in dev/prod (in-memory in test). See the
  rate-limiting notes in `MEMORY`/runbooks; the limiter is **fail-closed**.
- **decimal.js** — all money math; JS floats are forbidden at the boundary.

### Module map (`src/*`)

Each module owns its controllers, services, and DTOs. Confirmed by the controller/
service inventory.

| Module | Owns | Key controllers / services |
| --- | --- | --- |
| `ledger` | Chart of accounts, journal entries, **posting engine**, balances, accounting periods, opening balances | `accounts`, `journal`, `posting/posting.service.ts`, `balances`, `periods`, `document-lifecycle.service.ts` |
| `tax` | Tax codes (CRUD/seed) + the **tax engine** (PPN/PPh calculation → journal lines) | `tax-codes.service.ts`, `tax.service.ts` |
| `invoicing` | Sales invoices, purchase bills, payments, business partners, **AR/AP subledgers**, document numbering, the shared `DocumentPostingService` | `sales-invoices`, `purchase-bills`, `payments`, `business-partners`, `document-posting.service.ts`, `taxed-document.service.ts` (SALE/PURCHASE via `DocumentDescriptor`), `payment-targets.ts` (RECEIPT/DISBURSEMENT), `document-helpers.ts` (incl. `nextDocumentNumber`) |
| `reporting` | Read-only financial reports: balance sheet, income statement, general ledger, AR/AP aging, cash flow (trial balance is served by `balances`) | `reports.controller.ts` → `balance-sheet`, `income-statement`, `general-ledger`, `aging`, `cash-flow` services |
| `close` | Year-end close (zero P&L → retained earnings) + reopen | `closing.controller.ts`, `year-end-close.service.ts` |
| `auth` / `users` | JWT auth (stateful refresh tokens w/ rotation), guards, roles; user lookup | `auth.service.ts`, `refresh-token.service.ts`, guards/strategies; `users.service.ts` |
| `company` | Singleton company settings (fiscal-year start month, segregation-of-duties flag); **settings interpreter** — `fiscalYearFor` / `fiscalYearBounds` / `isSegregationViolation`; settings fields read ONLY inside this service | `company.service.ts` |
| `audit` | Append-only audit log of mutating requests + admin read API | `audit.interceptor.ts`, `audit.service.ts` |
| `metrics` | `prom-client` registry, `/metrics` scrape (token-gated), HTTP-duration + business counters | `metrics.service.ts`, `metrics.interceptor.ts`, `metrics-token.guard.ts` |
| `health` | Liveness/readiness probes (`HealthController`, registered directly in `AppModule`) | `health.controller.ts` |
| `common` | Cross-cutting shared seams: `money`, `pagination`, `idempotency`, `prisma`, `redis`, `dates`, `errors`, `filters`, `guards`, `interceptors`, `search`, `db`, `validators`, `openapi` | (libraries, see §3) |
| `config` | Env validation (`env.validation.ts`), env-file resolution, CORS parsing, Sentry scrubbing | (pure helpers) |

> Reporting is strictly read-only — it never posts. It composes off the same
> `BalancesService` primitives and signs by account **type** (contras negate).

---

## 2. Request lifecycle

### Bootstrap (`src/main.ts`)

1. **Sentry** init (only if `SENTRY_DSN` set; `beforeSend` scrubs PII) and
   process-level `uncaughtException`/`unhandledRejection` handlers.
2. `NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true })`,
   logger swapped to `nestjs-pino`.
3. `trust proxy: 1` (single Caddy edge), `helmet()`, `etag: false`, `enableCors(...)`.
   **No caching:** `noStoreApiResponses` (`src/common/http/no-store.ts`, an
   `app.use` right after `helmet()` and BEFORE the body parsers — mirrored in
   `test/e2e-helpers.ts`) sets `Cache-Control: no-store` on every `/v1/*`
   response — success or error, incl. body-parser rejections (malformed JSON
   400, over-cap 413) and guard 401/403/429. `/health`, `/ready`, `/metrics` and
   `/docs` are untouched. ETags are off in both bootstraps.
4. **Global `ValidationPipe`** — `whitelist: true`, `forbidNonWhitelisted: true`,
   `transform: true` (DTOs are the validated trust boundary).
5. **Global `AllExceptionsFilter`** + `enableShutdownHooks()`.
6. **URI versioning** — `VersioningType.URI`, `defaultVersion: '1'`. Every business
   route is served under `/v1`; operational probes opt out via
   `@Version(VERSION_NEUTRAL)` (`/health`, `/ready`, `/metrics`).
   **Gotcha:** `enableVersioning` must be called in *every* bootstrap — `main.ts`,
   the OpenAPI export script, and each e2e spec — or routes 404.
7. **Server timeouts**: `keepAliveTimeout 65s`, `headersTimeout 66s`,
   `requestTimeout 30s`; **body limits**: JSON + urlencoded capped at `1mb`.
   **Body depth:** `jsonDepthGuard` (`src/common/http/json-depth.ts`, applied to
   every route in `AppModule.configure`, so it runs after body parsing and before
   guards) rejects a body nested deeper than **32** levels with `400` — before the
   recursive audit sanitizer / class-transformer could overflow the stack (→ 500).
   The check itself is iterative. Because this middleware runs **before every
   guard, including the throttler**, a too-deep body gets `400` **even when the
   request is also unauthenticated** (400-before-401 precedence), and deep-body
   400s are **neither rate-limited nor audited** (no interceptor or guard-rejection
   row is written). The exposure is bounded by the 1 MB body cap (Caddy edge +
   `useBodyParser` above) and the cheap iterative check.
   **Input hygiene** is the global **`InputHygieneGuard`** (guard chain step 3
   below), not middleware — its body walk relies on this depth cap having run.
   Defence in depth in the audit path: `AuditService.record`
   makes every row storable (lone surrogates → U+FFFD, U+0000 stripped,
   null-prototype objects so a `__proto__` key is kept as data) and, if the INSERT
   still fails **on content** (SQLSTATE 22021 / 22P05 / 22P02 / 22001 / 54000 —
   `isAuditContentError`), retries once with body `{ "_unstorable": true }` and
   params `{}` (method / path / user / status / requestId kept), logging the
   original error. Any other failure (connection lost, pool exhausted, timeout) is
   logged once and **not** retried — a retry would only double the wait during an
   outage.
8. Swagger served at `/docs` except in production (unless `ENABLE_SWAGGER=true`).

### Guard chain (global, `src/app.module.ts` `APP_GUARD` order)

Guards run in registration order:

1. **`JwtAuthGuard`** (`src/auth/guards/jwt-auth.guard.ts`) — validates the bearer
   token; honors `@Public()` (skips auth) via the reflector.
2. **`UserThrottlerGuard`** (`src/common/guards/user-throttler.guard.ts`) — rate
   limits keyed by *verified* user id (`user:<id>`); anonymous requests are keyed
   `ip:<ip>` — except the **login handler only** (marked `@LoginIpThrottle()`),
   whose default bucket is `login:<email>` (plus the separate per-IP `loginIp`
   ceiling). Any other route ignores a body `email` (AUDIT3-17: honouring it
   everywhere let a rotating `email` field bypass the IP bucket on `/auth/refresh`).
   Runs after JwtAuthGuard so `req.user` is set. Redis-backed and **fail-closed**
   (503 if Redis is down); every 429 carries `Retry-After`.
3. **`InputHygieneGuard`** (`src/common/http/input-hygiene.ts`) — rejects a lone
   UTF-16 surrogate or U+0000 in any body key / string value, query key / value
   (`req.query`, decoded) or route param (`req.params`, percent-decoded by the
   router — `/v1/partners/%00`) with **400 `INVALID_CHARACTERS`** `{ location }`
   (`"path"` for a param, `"query"`, `"body"`), no Sentry — before the role check,
   validation and any write (Audit7 P1: such a string used to be written to a text
   column as U+FFFD while its jsonb audit row was rejected, leaving a write with no
   audit row). Valid surrogate pairs (emoji) pass. Because it runs **after**
   `JwtAuthGuard` and `UserThrottlerGuard`: an unauthenticated bad-character
   request on a protected route is a **401** first; a bad-character login is a 400
   only after the throttle (it counts against the login buckets); an unknown route
   with `%00` stays a **404** (no route matched, no guard ran). A **mutating**
   request rejected here is audited by `AllExceptionsFilter` under the normal rules:
   an authenticated caller's row carries its `userId` and the sanitized body
   (8 KiB cap); an anonymous one stores `{}`, or the repaired `{ email }` of a login
   attempt (capped by the rejection-audit limiter).
4. **`RolesGuard`** (`src/auth/guards/roles.guard.ts`) — enforces `@Roles(...)`;
   honors `@Public()`; no `@Roles` ⇒ any authenticated user passes.
5. **`PasswordChangeGuard`** (`src/auth/guards/password-change.guard.ts`) — a user
   flagged for a forced password change (`mustChangePassword`) gets `403
   PASSWORD_CHANGE_REQUIRED` on every handler not marked
   `@AllowWithPendingPassword()` (`/auth/change-password`, `/auth/me`, `/auth/logout`,
   `/auth/logout-all`).

### Interceptors (registered via `APP_INTERCEPTOR`; order = module scan order, outermost first)

- **`IdempotencyInterceptor`** (`src/common/idempotency/idempotency.module.ts`) —
  reserve-first idempotency for handlers marked `@Idempotent()`/`@IdempotentWrite()`.
- **`AuditInterceptor`** (`src/audit/audit.interceptor.ts`, registered in
  `AppModule` **before** `RequestTimeoutInterceptor`, so it is outermost) — records
  every mutating request (method in `MUTATING_METHODS`) with sanitized body +
  resolved status code (DomainError/HttpException statuses are recorded, not a
  blanket 500), exactly once — including a `408` (rxjs `timeout` unsubscribes from
  everything inside it, so an inner audit would miss it). Guard rejections
  (`401/403/429`) happen before any interceptor; `AllExceptionsFilter` (given the
  `AuditService` and the shared `RejectionAuditLimiter` in `main.ts`) writes their row **after** sending
  the response, fire-and-forget (a failed write is logged at warn). **Bounded
  writes** (`src/audit/rejection-audit-limiter.ts`, ONE in-process instance — an
  `AuditModule` provider shared by the filter and `AuditInterceptor` — one
  fixed-window key space of ≤ 10k keys, suppressed counts logged once per window):
  every filter-written rejection row and every **anonymous** interceptor row
  (login / refresh / logout 2xx, 4xx, 5xx, 408) goes through it. An anonymous row
  is keyed by client IP — **60 rows per IP per minute** — and also counts against
  **600 per minute across all IPs** (the global ceiling stops IPv6 address
  rotation from multiplying the per-IP budget). A row with a verified user —
  an authenticated 403/429 (`req.user`), or a **successful login / refresh**,
  keyed to the `sub` of the access token the response just issued
  (`accessTokenSubject` in `audit.interceptor.ts`) — is keyed `user:<id>` at
  **60 per user per minute** and never counts against, nor is blocked by, the
  anonymous global ceiling: a flood of cheap anonymous 401s can never starve a
  credential-proving success or a signed-in user's forbidden attempt out of the
  audit trail. Authenticated interceptor rows are not limited (the per-user
  throttler bounds them). Every successful login is also logged at info by
  `AuthService` (`{ event: "login", userId, ip }`). A row dropped by the limiter
  leaves only its once-per-window **suppression log** (`RejectionAuditLimiter`)
  as evidence — check it when the audit trail looks thin during a flood. Only
  401/403/429 are audited this way — a throttler-storage outage `503` and route 404s
  are not. A request-level `AUDITED` marker (`src/audit/audit-request.ts`) prevents
  a second row. Every row caps `path` (incl. query string) and serialized `params`
  at 512 characters (code points — a surrogate pair is never split, so the jsonb
  insert cannot fail on a lone surrogate).
  - **Body storage (AUDIT3-17, `auditBodyOf` in `audit-request.ts`):** an
    **anonymous** (no `req.user`) row — interceptor or filter, any status —
    stores `{}`: unauthenticated input is never copied into the append-only log.
    **Exception — login forensics:** on the LOGIN route only (`@LoginIpThrottle()`;
    the request is stamped `LOGIN_ATTEMPT` by `UserThrottlerGuard` before the
    throttlers run and by `AuditInterceptor`, so the filter-written 429 row sees
    it too) every row stores `{ "email": <trimmed, lowercased, NFC, ≤ 254 code
    points> }` — never the password or any other field (`loginAttemptBody`). A
    **bodyless handler** — one whose Nest route-argument metadata
    (`ROUTE_ARGS_METADATA`) binds no `@Body()` / `@Req()` / `@RawBody()`, e.g.
    `POST /auth/logout-all`, `/:id/post`, `DELETE` — stores `{}` on every
    interceptor-written row whatever the status (`handlerBindsBody` in
    `audit.interceptor.ts`): nothing it received was used. (A filter-written
    authenticated 403/429 guard rejection on such a route has no handler context,
    so it stores the body capped at 8 KiB.) An **authenticated** row stores the
    sanitized body, **capped** (`capBody`) at **512 KiB** when the body got past
    the global ValidationPipe — any status that is not a client error: a 2xx, a
    5xx, or a **408** (the write may have committed after the timeout). This
    holds because every body-binding handler takes a whole-body `@Body() dto` and
    a pipe rejection is always a 400 (`globalValidationPipe()`,
    `src/common/validators/global-validation-pipe.ts`); keep new handlers on a
    whole-body DTO. **8192 bytes** for every other authenticated row — a 4xx
    (pipe 400, guard 403/429, 409/422) and every row of a **read-only POST**
    marked `@ReadOnlyPost()` (`src/audit/read-only-post.ts`, read with
    `Reflector` — `POST /tax/calculate`, `POST /journal-entries/preview`: they
    change nothing, so they never need the large tier). Mark any new state-free
    POST the same way. So no caller, whatever its role, can park more than 8 KiB
    of unvalidated junk per row. An over-cap body is replaced by the object
    `{ "_truncated": true, "bytes": <n>, "preview": "<first 1024 code points of
    the JSON text>" }` — still a JSON object in the jsonb column (never a string
    cut mid-JSON), surrogate-safe. The 512 KiB cap sits above the largest
    DTO-valid body (worst case ≈ 317 KB: a 100-line JE whose 500-char
    descriptions are all JSON-escaped control characters; asserted in
    `audit-request.spec.ts`), so an **accepted write is never truncated**.
  - **Over-limit bodies:** a body over the 1 MB parser cap (`main.ts`) is
    answered by `AllExceptionsFilter` as **413 `PAYLOAD_TOO_LARGE`** (body-parser
    `entity.too.large` / `parameters.too.many`). Every other body-parser /
    `http-errors` client error (string `type` + 4xx `status`/`statusCode`:
    415 `charset.unsupported` / `encoding.unsupported`, 400 `request.aborted`)
    keeps its own status with code `HTTP_<status>` and the error's exposed
    message (`isBodyParserClientError` / `bodyParserClientStatus` in
    `exception-status.ts`) — a client error: no Sentry event, no audit row (the
    parser runs before guards, interceptors and the request-id middleware, so the
    envelope has no `traceId`). Malformed JSON is Nest's own 400 (`HTTP_400`).
  - **408-then-commit (for auditors):** a `408` row means the *response* timed out
    at 35s, **not** that nothing happened. The rxjs timeout only stops observing
    the handler; its DB transaction keeps running and may still **commit** after
    the 408 row was written (bounded by the 30s statement timeout per query). So a
    408 row can coexist with a committed business write (and its journal entry /
    document number) carrying a *later* timestamp and **no audit row of its own**.
    To reconcile, match the 408 row's `requestId`/`path`/time against the created
    entity (`createdAt`, document number), or the idempotency record of the same
    `Idempotency-Key`; a same-key client retry then gets the committed-`409` or a
    replay, never a second write.
  - **Replay rows:** a replay (the `IdempotencyInterceptor` answers with the stored
    response; no handler runs) is marked on the request
    (`markIdempotentReplay`, `src/common/idempotency/idempotency-replay.ts`) and the
    outer `AuditInterceptor` writes its row with `replayed = true` (NULL on every
    other row) — same `entityId` as the original, never a second creation.
  - **Timeout caveat (outermost = outside the 408):** on success the response is
    emitted only after the audit INSERT resolves, and that INSERT runs *outside*
    `RequestTimeoutInterceptor`. A stalled audit write is therefore **not** cut
    off by the 408 (35s): it is bounded by the pool's `connectionTimeoutMillis`
    (5s, waiting for a connection), the DB `statement_timeout` (30s, a running
    INSERT) and ultimately the HTTP socket timeout (40s, `main.ts`), after which
    the client sees a connection reset rather than a 408 — the business write has
    already committed, so the client should retry with the SAME `Idempotency-Key`.
- **`MetricsInterceptor`** (`src/metrics/metrics.module.ts`) — HTTP-duration
  histogram labelled by method/route/status.
- **`RequestTimeoutInterceptor`** (`src/common/interceptors/request-timeout.interceptor.ts`,
  registered in `AppModule`) — caps handler duration (default 35s, above the 30s DB statement timeout) → clean 408;
  exempts probe paths.

> Global `APP_INTERCEPTOR`s apply in module scan order (the root module's
> providers first, then imports depth-first). The one ordering that matters —
> Audit outside Timeout — is pinned by listing both in `AppModule.providers` and
> guarded by `test/audit-timeout.e2e-spec.ts`. Metrics/Idempotency (their own
> modules) sit inside both.

### Error → envelope

All thrown errors funnel through **`AllExceptionsFilter`**
(`src/common/filters/all-exceptions.filter.ts`), which applies the one ordered
classification `classifyException` (`src/common/errors/exception-status.ts` —
status, envelope, log level, Sentry) to:

- `DomainError` → its own `status` + `code` + `details` (the normal 4xx path).
- `HttpException` (incl. ValidationPipe) → `HTTP_<status>`; class-validator arrays
  become `details.errors`.
- `Prisma.PrismaClientKnownRequestError` → mapped table (`P2025`→404, `P2002`→409,
  `P2003`→409, …); unmapped codes stay 500 and are Sentry-captured.
- A Postgres **CHECK (23514) / NOT NULL (23502) violation** that escaped service
  validation (`P2011`, `P2010`/`P2039` + `meta.driverAdapterError`, or a bare
  `DriverAdapterError`; `isConstraintViolation`) → a generic **422
  `VALIDATION_FAILED`** "The request violates a data constraint" — a backstop
  for a validation gap (a code defect): ERROR-logged with the constraint name and
  Sentry-captured at `warning` (tag `kind: constraint-backstop`), but no
  SQL/constraint name in the response; primary validation stays in the services.
- A Postgres **22021 / 22P05** (an unstorable character — e.g. U+0000 — reaching the DB
  on a path the `InputHygieneGuard` does not cover; `isUnstorableCharacters`) →
  **400 `INVALID_CHARACTERS`** (warn log, no Sentry). A validator that *throws* inside
  the global pipe → 400 "Request validation failed" (`BackstopValidationPipe`
  backstop): a `URIError` (validator.js `isEmail` on a lone surrogate — client
  input) is a warn log only; any other throw is a validator defect, so it is also
  Sentry-captured at `warning` (tag `kind: validator-backstop`).
- A body-parser over-limit error → **413 `PAYLOAD_TOO_LARGE`**; any other body-parser
  4xx (415 charset/encoding, 400 aborted) → its own status as `HTTP_<status>` (info log,
  no Sentry, no audit row).
- Anything else → 500 `INTERNAL_ERROR`, logged + Sentry-captured (no stack leak).

Every envelope gets a `traceId` (the server-generated `X-Request-Id`) when present.

---

## 3. Core invariants & shared seams (the heart)

This section is the reason the codebase is safe to extend. Reuse these seams;
don't reinvent them.

### Double-entry balance
`assertBalanced(lines)` (`src/ledger/posting/assert-balanced.ts`) enforces the
core invariant: ≥2 lines, each line has **exactly one** of debit/credit > 0, and
total debits == total credits (compared as `Money`). Every posting path calls it;
the DB also enforces it as defense-in-depth: a one-sided CHECK on `journal_lines`
and a deferred constraint trigger (posted entry ⇒ ≥ 2 lines, debits = credits,
checked at COMMIT). Posted entries/lines are immutable at the DB (only the
POSTED→REVERSED link-up is allowed), so corrections are always reversals.

### `Money` value object
`src/common/money/money.ts` wraps `decimal.js` at **4 decimal places**,
`ROUND_HALF_UP` (matches Indonesian Faktur Pajak rounding). `Money.of` accepts
`string | Decimal` **only** — never a JS number, so float drift can't enter.
`toPersistence()` emits the canonical fixed-4dp string written to the DB.

### Gapless per-`(type, fiscalYear)` numbering
**`nextSequenceNumber(tx, table, key)`** (`src/common/db/sequence.ts`, also exports
`SqlTx`) is the single gapless-numbering primitive: `INSERT … ON CONFLICT DO NOTHING`
then `SELECT … FOR UPDATE` + increment, all **inside the write transaction** — so
numbers are gapless and serialized under concurrency. Both `PostingService.nextNumber`
(journal entries) and `nextDocumentNumber` (invoice/bill/payment doc numbers,
`src/invoicing/document-helpers.ts`) delegate to it. (The old `RawTx` type was
deleted when this was extracted.)

### The tx-composable `PostingService`
`src/ledger/posting/posting.service.ts` is the **single writer of posted journal
entries** (manual, invoice, bill, payment, reversal, close). It splits work so
document services can compose posting into their own `prisma.transaction(...)`:
- `preparePosting(input, postedBy)` — pre-tx reads (balance, segregation-of-duties,
  open period, postable accounts, year-not-closed) → returns a **branded `PreparedPosting`
  token** (minted via a module-private `PROTOCOL_MINT` symbol). In-tx writes
  (`createPostedEntryInTx` / `reverseInTx`) **require** that token; you cannot
  construct one from outside PostingService. `prepareReversal(...)` returns a
  `PreparedReversal` token by the same mint.
- `createPostedEntryInTx(tx, prepared)` / `reverseInTx(tx, prepared)` — accept the
  branded token and write within a caller-supplied `LedgerTx`.
- **`stampPostedInTx(tx, periodId, fiscalYear, opts?)`** — the private in-tx choke
  point shared by all three write paths (create / postDraft / reversal): runs
  `assertPostablePeriodInTx`, assigns the gapless JE number, and increments the
  posting metric.
- `assertPostablePeriodInTx(tx, periodId, fiscalYear)` — the authoritative **in-tx
  TOCTOU guard**, and the **first statement** in every posted-entry write path: a
  shared advisory lock on the fiscal year (the year-close holds the exclusive one)
  + re-check `year_end_closings`, then `SELECT … FOR SHARE` on the period row +
  re-check `OPEN`. The pre-tx checks in `preparePosting` are a fast-fail; this is
  the real serializer.

`reverse`/`reverseInTx` write the debit/credit-swapped entry, mark the original
`REVERSED`, and rely on a unique on `reversal_of_id` (P2002 → clean "already
reversed" 422). `postDraft` locks the draft `FOR UPDATE` and re-checks `DRAFT`
*before* consuming a number, so a retry can't burn a gapless number.

### Idempotency (reserve-first)
`@IdempotentWrite()` (`src/common/idempotency/idempotent-write.decorator.ts`)
documents + marks money-mover write handlers. `IdempotencyInterceptor`
(`…/idempotency.interceptor.ts`) requires a validated `Idempotency-Key` header
(`/^[A-Za-z0-9._:-]{1,128}$/`), keys by method + full path (query string
included) + body hash, **reserves** before the handler runs, **completes** with the
response on success, and **releases** on error so a failed call is retryable. A
replay reproduces the original status + body.

### Soft-delete extension
`src/common/prisma/soft-delete.extension.ts` (`applySoftDelete`) is a Prisma client
extension over the models in `SOFT_DELETE_MODELS` (User, Account, JournalEntry,
TaxCode, BusinessPartner, SalesInvoice, PurchaseBill, Payment). It auto-injects
`deletedAt: null` into reads/updates, **forbids hard `delete`/`deleteMany`/`upsert`**
(throws → 500, a loud programmer-error guard). Soft delete is a plain `update`
with `tombstoneData()`. Always go through `PrismaService.client` so this applies.

### `AccountRole` — system accounts by role, not code
System accounts are identified by the `AccountRole` enum on `Account.role`, **never**
by hard-coded account codes. `findControlAccountId(prisma, role)`
(`src/invoicing/document-helpers.ts`) resolves a control account by role (422 if
missing). Singleton roles (e.g. `AR_CONTROL`, `AP_CONTROL`, `RETAINED_EARNINGS`,
`TAX_EXPENSE`) are uniqueness-enforced; `CASH` is a set. Reporting also branches on
`role` (e.g. cash-flow filters `role === 'CASH'`).

### Other shared seams
- **`listPaginated`** (`src/common/pagination/paginated.ts`) — the offset-pagination
  + optional fuzzy-`?q=` list seam returning `{ data, total, limit, offset }`.
  Callers supply `page` / `search` / `hydrate` / `present` closures.
- **`serializeMoney(obj, fields)`** (`src/common/money/serialize-money.ts`) — the
  single home for the Decimal→fixed-4dp-string cast in presenters.
- **`DocumentPostingService`** (`src/invoicing/document-posting.service.ts`) — see §4.
- **`DocumentLifecycleService`** (`src/ledger/document-lifecycle.service.ts`) —
  shared `softDeleteDraft` / reverse-with-guard for documents.
- **`signing.ts`** (`src/ledger/balances/signing.ts`): two pure functions —
  `signedNet(normalBalance, debit, credit)` (normal-balance–aware sign) and
  `naturalSide(type, debit, credit)` (contra-aware, e.g. Akumulasi Penyusutan).
  All normal-balance signing in reporting + balances routes through here.
- **`query-dates.ts`** (`src/common/dates/query-dates.ts`): `asOfOrToday` /
  `dateRange` / `optionalDateRange` — the controller date-boundary seam (audit
  `from > to` → 422). **`parseDate`** (`src/common/dates/parse-date.ts`) =
  `value ? new Date(value) : undefined` for optional date conversion in controllers.
- **`classifyException`** / **`statusFromException`** (`src/common/errors/exception-status.ts`):
  the single exception classification (status + envelope + log level + Sentry);
  `AllExceptionsFilter` applies it, `AuditInterceptor` reads its status via
  `statusFromException`, so the audit log records the resolved status, not a blanket 500.
  Add a new error family there, never as a filter branch.
- **`POSTED_JE`** (`src/ledger/balances/posted-entry.sql.ts`): shared
  `Prisma.sql` predicate `je.posted_at IS NOT NULL AND je.deleted_at IS NULL` used
  by all raw-SQL balance queries.
- **`tombstoneData` / `tombstoneValue`** (`src/common/prisma/tombstone.ts`):
  `update` data for tombstone deletes (works on the client or a `tx`) for reference-master rows (users, accounts,
  tax-codes, business-partners), where the unique field (e.g. `email`, `code`) is
  mangled on delete to free the value for re-use.
- **Dates**: `fiscalYearForDate(date, startMonth)` (`src/common/dates/fiscal-year.ts`)
  and `truncateToUtcDay(date)` (`src/common/dates/utc-day.ts`) — all fiscal-year /
  day math is UTC and centralized here.
- **`mapUniqueViolation`** (`src/common/errors/map-unique-violation.ts`),
  **`trigramSearch`** (`src/common/search/trigram-search.ts`),
  **`PaginatedDto` factory** (`src/common/openapi/paginated-dto.ts`),
  **`@ApiMoney`** (`src/common/openapi/api-money.decorator.ts`).

---

## 4. Data flow example — posting a sales invoice

Tracing `POST /v1/sales-invoices/:id/post` end-to-end shows how the seams compose
(`src/invoicing/sales-invoices.service.ts` → `document-posting.service.ts` →
`tax.service.ts` → `posting.service.ts`):

1. **Controller** (`sales-invoices.controller.ts`, `@IdempotentWrite()` + `@Roles`)
   calls `SalesInvoicesService.post(id, postedBy)`.
2. The service loads the draft (must be `DRAFT`), re-validates the partner is an
   active customer, and resolves the AR settlement account via
   `findControlAccountId(prisma, 'AR_CONTROL')`.
3. It maps document lines to taxable lines (`taxableLines` → `amount = qty × unitPrice`)
   and delegates to `DocumentPostingService.post(params, finalize)`.
4. **`DocumentPostingService.post`**:
   - `TaxService.calculate(...)` (`src/tax/tax.service.ts`) — validates tax codes,
     aggregates DPP per code, rounds each code's tax **once** to whole rupiah,
     builds balanced journal lines, and computes settlement
     `= subtotal + PPN − PPh` (rejects a non-positive settlement with a 422). The
     AR settlement line is the debit that ties to the control account.
   - `posting.preparePosting(journalInput, postedBy)` — pre-tx validation, returns a
     **`PreparedPosting` token** (branded; required by the in-tx write methods).
   - **`$transaction`**: `lockDraftInTx(tx, …)` (internal — `SELECT … FOR UPDATE` +
     re-check `DRAFT`) → `docNumber.next(tx, 'INV', fiscalYear)` (gapless) →
     `buildRef` → `posting.createPostedEntryInTx(tx, prepared)` (which runs
     `stampPostedInTx` → `assertPostablePeriodInTx` first, assigns the gapless JE
     number, and writes the balanced entry) → `finalize(ctx)` updates the invoice row
     to `POSTED` with `invoiceNumber`, `invoiceRef`, `fiscalYear`, and
     `journalEntryId`.
5. **Reconciliation:** because the settlement leg posts to the `AR_CONTROL` account
   and the invoice is the AR subledger row, the subledger ↔ control-account balance
   stays reconciled (aging reports read the subledger; the balance sheet reads the
   control account; they must agree as-of any date). Payments later allocate against
   the invoice under a `FOR UPDATE` over-allocation guard.

Purchase bills and payments follow the same shape (AP via `AP_CONTROL`; payments
post cash vs. control and reconcile allocations). The **year-end close**
(`src/close/year-end-close.service.ts`) is the other writer: it serializes on
`pg_advisory_xact_lock(fiscalYear)`, zeroes cumulative P&L into the
`RETAINED_EARNINGS` (Laba Ditahan) account via a `CLOSING` entry, and posts through
the same `PostingService`.

**Close/reopen borrow a second pool connection (accepted trade-off).** Inside the
tx that holds the exclusive year lock, `preparePosting` (close) / `prepareReversal`
(reopen) run their plain validation reads on the **base client**, i.e. on a second
pool connection. Close/reopen are rare and ADMIN-only, so this cannot exhaust the pool
in normal operation, and those reads never wait on the tx's own locks. Under extreme
contention — the pool full of posts that are themselves queued on the year's shared
advisory lock — the second connection cannot be acquired: the close/reopen fails after
the pool's `connectionTimeoutMillis` (5s) or the tx timeout (a `500`, or a retryable
`409` for a transient tx abort), its tx rolls back and releases the lock, and the
queued posts proceed. It is **self-healing** — nothing half-commits; the admin simply
retries.

---

## 5. Where to go next

- **Accounting concepts** (DPP, PPN/PPh kinds, control vs. subledger, fiscal year,
  the close) → [`./domain-glossary.md`](./domain-glossary.md).
- **Coding rules** (DTO/validation conventions, money serialization in presenters,
  test layout, list-envelope rules) → [`./conventions.md`](./conventions.md).
- **Schema, migrations, DB-level constraints/triggers** →
  [`./database-and-migrations.md`](./database-and-migrations.md).
- **Deploy / runtime topology** → [`./deploy.md`](./deploy.md).
