# Design: v1 Versioning, Generalized Idempotency, and List Pagination

- **Date:** 2026-06-13
- **Status:** Approved (design); pending spec review → implementation plan
- **Type:** Best-practice polish (no new business features)
- **Repo:** `accounting-api` (NestJS + Prisma 7, single-VM, behind Caddy)

## 1. Context & Motivation

An architectural gap analysis flagged three best-practice gaps in the otherwise
feature-complete API:

1. **No API versioning.** `main.ts` never calls `enableVersioning()`; all 64
   routes are unprefixed (`/accounts`, `/ledger/journal-entries`, …). There is
   no room to evolve the contract without breaking clients.
2. **Idempotency only on journals.** The `Idempotency-Key` mechanism lives
   inside `JournalService` and is hard-coupled to `JournalEntry` (the
   `idempotency_keys` table stores `result_entry_id`; the helper returns
   `Promise<JournalEntry>`). The money-moving invoice/bill/payment posting
   endpoints have no protection against duplicate submission.
3. **Unbounded list endpoints.** Six `findMany` calls return entire tables with
   no `take`/`skip`: `accounts`, `tax/codes` (reference data) and `partners`,
   `sales-invoices`, `purchase-bills`, `payments` (transactional data). The
   transactional lists grow without limit.

This work closes all three under a single `/v1` breaking change so the contract
churn happens exactly once.

## 2. Goals / Non-Goals

**Goals**
- Introduce URI versioning with `/v1` as the canonical, only-supported version.
- Replace the journal-specific idempotency with one generic, entity-agnostic
  mechanism covering all create + money-moving endpoints.
- Add offset pagination (matching the existing journal envelope) to all six
  unbounded lists.
- Regenerate `openapi.json` and update the API guides to match.

**Non-Goals**
- No new business features or domain logic changes.
- No idempotency-key retention / garbage-collection job (noted as future work;
  keys are small rows and the demo volume is low).
- The separate frontend repo's base-URL bump (`→ /v1`) is a downstream task,
  tracked here but performed outside this repo.
- `/audit` keeps its current bare-array-with-params shape (out of scope; it is
  already bounded by `take`/`skip`).

## 3. Decisions (with rationale)

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| D1 | Versioning style | **URI, hard cutover to `/v1`** (`defaultVersion: '1'`); unprefixed business paths → 404 | Cleanest surface; one break, done under a single version bump |
| D2 | Probe routes | **Version-neutral** `/health`, `/ready`, `/metrics` | Keeps the Docker healthcheck (`/health`) and Prometheus scrape (`/metrics`) working without editing infra config |
| D3 | Idempotency scope | **All creates + money-moving transitions** (`:id/post`, `:id/void`, `year-end`) + existing journals/opening-balances | A key only earns its place when a retry could duplicate a row or double a financial effect |
| D4 | Idempotency mechanism | **Generic `@Idempotent()` interceptor + JSON response snapshot**; refactor journals onto it | One uniform, entity-agnostic mechanism; replay returns the original response verbatim (correct idempotency semantics) |
| D5 | Key requirement | **Required** on included endpoints (`422` if missing) | Strongest guarantee; uniform contract; acceptable because it ships under the `/v1` break |
| D6 | Body-hash guard | **Included** — same key + different body → `422` | Catches client bugs where a key is accidentally reused for a different request (Stripe-style) |
| D7 | Pagination scope | **All six unbounded lists** (2 reference + 4 transactional) | Closes the real growth exposure, not just the flagged symptom |
| D8 | Pagination shape | **Match journal envelope** `{ data, total, limit, offset }`, `?limit` (default 50, max 200) + `?offset` | Reuses the one convention already in the codebase |

## 4. Detailed Design

### 4.1 API Versioning

`src/main.ts`:

```ts
import { VersioningType, VERSION_NEUTRAL } from '@nestjs/common';

app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
```

- With `defaultVersion: '1'`, every controller is served under `/v1`
  automatically — no per-controller `@Version()` needed for the business API.
- **Exceptions:** `HealthController` and `MetricsController` get
  `@Version(VERSION_NEUTRAL)` so they remain at `/health`, `/ready`, `/metrics`.
- `AuthController` **is** versioned (`/v1/auth/login`, `/v1/auth/refresh`) — it
  is API surface, not an operational probe.
- The Swagger `DocumentBuilder` already declares version `1.0.0`; the exported
  `openapi.json` will reflect `/v1` paths after regeneration.

**Infra left untouched** thanks to D2: `docker-compose.prod.yml` healthcheck
(`http://127.0.0.1:3000/health`), `monitoring/prometheus.yml`
(`metrics_path: /metrics`), and the `Caddyfile` `@metrics` matcher all keep
working as-is.

### 4.2 Idempotency

#### Schema (`prisma/schema.prisma`)

Generalize `IdempotencyKey` (hand-authored migration, per project convention):

```prisma
model IdempotencyKey {
  key          String    @id
  method       String                       // e.g. "POST"
  path         String                       // resolved route, e.g. "/v1/payments/<id>/post"
  requestHash  String    @map("request_hash")  // sha256 of canonical request body
  response     Json?                        // serialized handler result; null = in-flight
  httpStatus   Int?      @map("http_status")   // status to replay (201 / 200)
  createdAt    DateTime  @default(now()) @map("created_at")
  completedAt  DateTime? @map("completed_at")

  @@map("idempotency_keys")
}
```

- **Dropped:** `result_entry_id` (journal-specific). Existing rows are transient
  idempotency records; losing their replay on migration is acceptable.
- `response == null` ⇒ a request is in-flight under this key.

#### Interceptor + Service (`src/common/idempotency/`)

- `@Idempotent()` decorator marks a handler; an `IdempotencyInterceptor`
  (global, no-op unless the handler is decorated) does the work via a small
  `IdempotencyService`.
- **Flow (reserve-first — the same race-safe pattern journals use today):**
  1. Read `Idempotency-Key` header. **Missing → `422`** (D5).
  2. Compute `requestHash = sha256(canonicalJson(body))`.
  3. `INSERT` reservation row `{ key, method, path, requestHash, response: null }`.
     - On unique-violation (`P2002`), the key already exists → go to replay (5).
  4. Run the handler. On success: `UPDATE` row with `response`, `httpStatus`,
     `completedAt`, and return the result. On error: `DELETE` the reservation
     (failures are never cached, so a retry can re-attempt) and rethrow.
  5. **Replay path** (existing row):
     - `method`+`path` differ from the request → `422` (cross-endpoint reuse).
     - `requestHash` differs → `422` (key reused with a different body — D6).
     - `response == null` → `409` (a request with this key is in progress).
     - otherwise → return stored `response` with stored `httpStatus`.

Response is captured as the controller's return value (already plain DTOs/ISO
strings) and stored as JSON; replay re-emits it with the recorded status code so
`201` vs `200` is preserved.

#### Journal refactor

- Delete `runIdempotent` / `reserveIdempotent` from `JournalService`; remove the
  `@Headers('idempotency-key')` plumbing from the journal & opening-balances
  controllers.
- Decorate the journal create/post/reverse and opening-balances endpoints with
  `@Idempotent()`. They now share the one mechanism and the **required-key**
  contract (their previously-optional key becomes mandatory — covered by D5 and
  exercised by updated tests).
- Implementation note for the plan: confirm the journal `POST` draft-creation
  branch (`createDraft` vs `createAndPost`) is covered by the interceptor.

### 4.3 Pagination

- **Shared query DTO** `src/common/pagination/pagination-query.dto.ts`:
  `limit?` (`@IsInt @Min(1) @Max(200)`, default 50) and `offset?`
  (`@IsInt @Min(0)`, default 0). Extracted from the inline journal DTO and
  reused (journal DTO refactored to extend it).
- **Services** (`accounts`, `tax-codes`, `business-partners`, `sales-invoices`,
  `purchase-bills`, `payments`): each `list()` adds `take`/`skip` + a parallel
  `count()` and returns `{ data, total, limit, offset }`. Existing filters
  (`partnerId` / `status` on documents) and ordering (`code asc` for reference,
  `createdAt desc` for transactional) are preserved.
- **Response DTOs:** one `*ListResponseDto` envelope per resource (the OpenAPI
  contract guard requires named schemas), each `{ data: ItemDto[], total, limit,
  offset }`.
- **Breaking change:** these six lists change from bare arrays to envelopes.
  Intentional and bundled under `/v1`.

## 5. Endpoint Matrix

All paths shown with the `/v1` prefix.

### Idempotency — INCLUDE (key required)

| Endpoint | Kind |
|----------|------|
| `POST /v1/ledger/accounts` | create |
| `POST /v1/tax/codes` | create |
| `POST /v1/partners` | create |
| `POST /v1/sales-invoices` | create |
| `POST /v1/purchase-bills` | create |
| `POST /v1/payments` | create |
| `POST /v1/ledger/periods/generate` | create (rows) |
| `POST /v1/sales-invoices/:id/post` · `:id/void` | money-moving |
| `POST /v1/purchase-bills/:id/post` · `:id/void` | money-moving |
| `POST /v1/payments/:id/post` · `:id/void` | money-moving |
| `POST /v1/close/year-end` | money-moving |
| `POST /v1/ledger/journal-entries` · `:id/post` · `:id/reverse` | refactor (existing) |
| `POST /v1/ledger/opening-balances` | refactor (existing) |

### Idempotency — EXCLUDE (no key; already idempotent or semantically wrong)

| Endpoint(s) | Reason |
|-------------|--------|
| All `PATCH` (`accounts/:id`, `tax/codes/:id`, `partners/:id`, `sales-invoices/:id`, `purchase-bills/:id`, `company/settings`) | Same body → same state |
| All `DELETE :id` (journals, accounts, tax/codes, partners, invoices, bills, payments) | Idempotent by HTTP semantics |
| All `:id/deactivate` (accounts, tax/codes, partners) | Boolean flip |
| `ledger/periods/:id/close` · `:id/reopen`, `close/year-end/:fiscalYear/reopen` | Status flip, no ledger entries, status/advisory-lock guarded |
| `auth/login`, `auth/refresh` | Must mint fresh tokens; caching a token response is a security anti-pattern |
| `tax/calculate` | Pure computation, nothing persisted |

### Pagination — envelope `{ data, total, limit, offset }`

`GET /v1/ledger/accounts`, `GET /v1/tax/codes`, `GET /v1/partners`,
`GET /v1/sales-invoices`, `GET /v1/purchase-bills`, `GET /v1/payments`.
(`journal-entries`, `periods`, `audit` already paginate — unchanged.)

## 6. Testing

- **Unit** (`IdempotencyService`/interceptor): missing key → 422; first call
  stores + returns; replay returns stored response + status; in-flight → 409;
  handler error evicts reservation; cross-endpoint key reuse → 422; body-hash
  mismatch → 422.
- **e2e:**
  - All existing suites repointed to `/v1`; assert `/health` + `/metrics` stay
    unversioned (200) and unprefixed business paths → 404.
  - Idempotent replay on each included endpoint (same key+body returns the same
    resource; no duplicate row created).
  - Pagination envelope shape + `total`/`limit`/`offset` honored on each of the
    six lists; filters still work.
  - Journal/opening-balances suites updated for the now-required key.
- Existing **38 unit + 147 e2e** updated accordingly; the OpenAPI contract guard
  must pass against the regenerated spec.

## 7. Docs & Downstream

- Regenerate `docs/api/openapi.json` (`npm run openapi:export`): `/v1` paths, the
  `Idempotency-Key` header parameter on included endpoints, and the new envelope
  schemas. Run the contract guard.
- Update `docs/api/frontend-guide.md` (remove "journal-list is the only
  enveloped list"; document the shared pagination envelope and required
  `Idempotency-Key`), `docs/api/frontend-agent-brief.md`, `README.md`,
  `CHANGELOG.md` (`[Unreleased]`).
- **Downstream (outside this repo):** frontend base URL → `/v1`; frontend must
  send `Idempotency-Key` on included writes.

## 8. Build Sequence

1. **Versioning** — `enableVersioning` + neutral probes; update e2e paths.
2. **Idempotency** — schema + migration → `IdempotencyService`/interceptor →
   wire included endpoints → refactor journals off the old mechanism.
3. **Pagination** — shared query DTO → six services → six envelope DTOs.
4. **Docs** — regenerate `openapi.json` + guides; run contract guard.
5. **Full test pass** — unit + e2e green.

## 9. Risks & Mitigations

- **Required key tightens the journal contract.** Mitigated: bundled under the
  `/v1` break; all journal tests and the frontend updated together.
- **Response-snapshot replay must match live serialization.** Controllers return
  plain DTOs/ISO strings, so JSON capture is faithful; the recorded `httpStatus`
  preserves 201 vs 200.
- **Dropping `result_entry_id`** loses replay for any in-flight pre-migration
  keys — acceptable (transient data, demo volume).
- **Envelope is a breaking response change** for six lists — intentional, under
  `/v1`, reflected in the regenerated `openapi.json`.
