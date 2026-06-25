# Coding & Contribution Conventions

The binding rules for changing this codebase (NestJS 11 + Prisma 7 accounting
API). These are not suggestions — most are enforced by the type system, lint, or
tests, and the rest protect financial correctness. Read this before opening a PR.

See also [`./architecture.md`](./architecture.md) for module layout and the
request lifecycle, [`./database-and-migrations.md`](./database-and-migrations.md)
for schema/migration mechanics, and [`./testing.md`](./testing.md) for how to run
and write the two test tiers.

---

## 1. Money discipline

Money is the whole point of this system; floating-point money is a correctness
bug, not a style nit.

- **Represent every monetary amount with the `Money` class.** Never use a JS
  `number`, `parseFloat`, `toFixed`, or raw arithmetic for money.
  → `src/common/money/money.ts`. Backed by `decimal.js`, fixed at `SCALE = 4`
  decimal places, rounded `ROUND_HALF_UP` (matches Indonesian Faktur Pajak
  rounding).
- **Construct only via `Money.of(string | Decimal)`, `Money.zero()`, or
  `Money.sum()`.** `Money.of()` deliberately rejects JS `number` at the type
  level — a float can never sneak in before it is wrapped in exact decimal math.
  (The one place a raw `number` is allowed is `Money.multiply(factor)`, where the
  factor is a rate/quantity, not an amount.)
- **Store and transport money as decimal strings.** Persist with
  `money.toPersistence()` (always 4dp). Serialize in DTOs/responses as strings
  via the shared `serializeMoney` helper; document them with `@ApiMoney`. Never
  emit a money field as a JSON number — precision is lost in transit.
- **Validate incoming money strings with `@IsMoneyString()`**
  (`src/common/validators/is-money-string.ts`) in request DTOs — it enforces
  non-negative and ≤ 4 decimal places. The shared `DocumentLineDto`
  (`src/invoicing/dto/document-line.dto.ts`) uses it for `quantity` and `unitPrice`
  on both sales-invoice and purchase-bill lines; `AllocationDto.amount` likewise.
  **Exception:** tax-code `rate` fields stay `@Matches` at 6 dp (they are rates,
  not money amounts).
- **Do math through `Money`** (`add`, `subtract`, `multiply`, `roundToRupiah`,
  `equals`, `greaterThan`, `isZero`, `isNegative`), never by unwrapping to a
  Decimal/number and back. `roundToRupiah()` is for the final whole-rupiah
  rounding step only.

## 2. Error model

One stable error envelope, no leaked internals.

- **Throw domain errors, not ad-hoc `Error`/`HttpException`.** Use the typed
  subclasses in `src/common/errors/domain-errors.ts`:
  `ValidationFailedError` (422), `NotFoundDomainError` (404),
  `ConflictDomainError` (409), `UnauthorizedDomainError` (401),
  `ForbiddenDomainError` (403), `UnbalancedEntryError` (422),
  `ClosedPeriodError` (409), `ClosedYearError` (409), `InvalidAccountError`
  (422), `SegregationOfDutiesError` (403). Each carries its own `code` + HTTP
  `status` + optional `details`.
- **Note:** `ValidationFailedError` is for *domain-rule* failures ("entry does
  not balance"), NOT request/DTO validation — the latter is the NestJS
  `ValidationPipe` (class-validator), which throws its own `HttpException`.
- **The global filter owns response shaping.** `AllExceptionsFilter`
  (`src/common/filters/all-exceptions.filter.ts`) maps everything to the
  envelope `{ code, message, details?, traceId }`. Don't build error responses by
  hand in controllers/services.
- **Never leak stack traces or internal messages.** Unknown/unmapped exceptions
  become a generic `500 INTERNAL_ERROR`; the real detail is logged and sent to
  Sentry, not returned to the client.
- **Unique-constraint conflicts → 409.** Prisma `P2002` is mapped to a 409 by
  the global filter; in a service `try/catch` use `mapUniqueViolation(err, msg)`
  (`src/common/errors/map-unique-violation.ts`) to rethrow it as a
  `ConflictDomainError` with a friendly message, and rethrow everything else
  unchanged. `P2025` → 404 is handled by the filter automatically.

## 3. API conventions

- **Every business route lives under `/v1` (URI versioning).** Controllers use
  bare paths (e.g. `@Controller('ledger/accounts')`); the `/v1` prefix comes from
  `app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })`.
  → `src/main.ts`. This call **must be repeated in EVERY bootstrap**: `main.ts`,
  the OpenAPI export script (`src/scripts/export-openapi.ts`), and every e2e
  spec's app setup — omitting it silently drops the `/v1` prefix and routes 404.
- **Authentication is on by default.** Mark genuinely public endpoints with
  `@Public()` (`src/auth/decorators/public.decorator.ts`); current public
  routes are auth, health, and metrics only.
- **RBAC via `@Roles(...)`** (`src/auth/decorators/roles.decorator.ts`, roles in
  `src/auth/role.enum.ts`). Apply at the handler (or controller) level on every
  state-changing route; reads may stay role-open where appropriate.
- **Validate `:id` path params with `ParseUUIDPipe`** — e.g.
  `@Param('id', ParseUUIDPipe) id: string`. Rejects malformed ids with a 400
  before they reach the service/DB.
- **The global `ValidationPipe` is strict** (`whitelist: true`,
  `forbidNonWhitelisted: true`, `transform: true`, in `src/main.ts`): unknown
  body fields are rejected (422-style validation error), and payloads are
  transformed into DTO instances. Define request shapes as DTO classes with
  class-validator decorators — don't read untyped `req.body`.
- **Lists use the pagination envelope `{ data, total, limit, offset }`.** Drive
  it through the shared `listPaginated` seam (`src/common/pagination/paginated.ts`)
  and accept a `PaginationQueryDto` (`@Max(MAX_LIMIT)`; `MAX_LIMIT = 200`,
  `DEFAULT_PAGE_SIZE = 50` in `src/common/pagination/pagination.constants.ts`).
  All transactional lists AND accounts/tax-codes return this envelope — there are
  no remaining bare-array list endpoints, so a new list must use the envelope too.
- **Optional date query params → `parseDate` / `query-dates` helpers.**
  Convert a nullable string param with `parseDate(value)`
  (`src/common/dates/parse-date.ts`, returns `Date | undefined`). For the common
  cases use the higher-level helpers in `src/common/dates/query-dates.ts`:
  `asOfOrToday(asOf?)` (defaults to today), `dateRange(from, to)` (required pair,
  422 if from > to), `optionalDateRange(from?, to?)`. These are the shared
  controller date-boundary seam — don't inline `new Date(x)` in controllers.

## 4. Idempotency

- **Money-movers and document/payment creates require an `Idempotency-Key`
  header.** Decorate the write handler with `@IdempotentWrite()`
  (`src/common/idempotency/idempotent-write.decorator.ts`), which both documents
  the required header in OpenAPI and arms the global `IdempotencyInterceptor`.
  Current sites: journal create/post, opening balances, year-end close, sales
  invoices, purchase bills, payments.
- **A request to such a route WITHOUT the header → 422** (`ValidationFailedError`,
  thrown by the interceptor in `src/common/idempotency/idempotency.interceptor.ts`).
  The key must match `^[A-Za-z0-9._:-]{1,128}$`.
- **Reserve-first pattern.** The interceptor reserves the key (DB unique
  constraint) before running the handler, replays the stored response + status on
  retries, and releases the reservation if the handler throws. Don't add your own
  ad-hoc dedupe — reuse this seam. The key is scoped to method + full URL
  (query string included) + a body hash, so different targets can't replay each
  other's responses.

## 5. Migrations

- **Migration SQL is HAND-AUTHORED.** Generate the file with
  `prisma migrate dev --create-only` (or the `db:migrate` script), then write/edit
  the SQL by hand — we do not let Prisma auto-apply inferred DDL. This is how
  partial-unique indexes, append-only triggers, advisory-lock helpers, and gapless
  numbering constraints get expressed. Full mechanics in
  [`./database-and-migrations.md`](./database-and-migrations.md).
- **After any `prisma/schema.prisma` change, run `npm run db:generate`** to
  regenerate the typed client before relying on the new types or committing.

## 6. Soft-delete

- **Reads/writes go through the extended `prisma.client`**, never a raw
  `PrismaClient`. → `src/common/prisma/soft-delete.extension.ts`.
- **Deletes are tombstones.** Use the model `softDelete(where, deletedBy?)`
  method (sets `deletedAt`/`deletedBy`). Hard `delete`/`deleteMany`/`upsert` on a
  `SOFT_DELETE_MODELS` model throws a programmer-error `Error` (→ 500 on
  purpose) — there is no hard-delete route.
- **`deleted_at IS NULL` is auto-injected** on `find*`/`count`/`aggregate`/
  `groupBy`/`update*` for the soft-delete models (`User`, `Account`,
  `JournalEntry`, `TaxCode`, `BusinessPartner`, `SalesInvoice`, `PurchaseBill`,
  `Payment`). So:
  - **Don't double-filter** `deletedAt: null` on ordinary Prisma-model reads —
    the extension already did it.
  - **DO add `deleted_at IS NULL` explicitly in raw SQL** (`$queryRaw` /
    `$executeRaw`), which bypasses the extension entirely.

## 7. Identify system accounts by role, not code

- **Use `account.role` (the `AccountRole` enum), never hardcoded account-code
  strings.** → `prisma/schema.prisma` (`enum AccountRole { CASH, AR_CONTROL,
  AP_CONTROL, RETAINED_EARNINGS, OPENING_BALANCE_EQUITY, TAX_EXPENSE }`,
  nullable `Account.role`). The old by-code constants (CASH_CODES, AR/AP control,
  retained-earnings, etc.) were deleted. `CASH` is a set; the other five are
  singletons (partial-unique index + create-time 409). Resolving a system account
  by matching a code string is a bug.

## 8. Quality gate

- **`npm run verify` must pass before merge.** It runs, in order:
  `typecheck` (`tsc --noEmit`, 0 errors) → `lint:ci` (ESLint
  `--max-warnings 0`) → `test:cov:all` (unit + e2e + merged `nyc check-coverage`).
  → `package.json` scripts.
- **TypeScript is strict** (`strict`, `strictNullChecks`, `noImplicitAny`,
  `noFallthroughCasesInSwitch` in `tsconfig.json`). Don't loosen it; fix the
  types.
- **Lint is zero-warning in CI.** `lint:ci` uses `--max-warnings 0`, so a
  `warn`-level rule (e.g. `no-floating-promises`, `no-unsafe-argument`) fails the
  build just like an error. Prettier runs through ESLint
  (`prettier/prettier: error`). → `eslint.config.mjs`. Use `npm run lint`
  (with `--fix`) / `npm run format` locally before pushing.
- **The authoritative coverage gate is the merged unit∪e2e report** checked by
  `nyc check-coverage` (`.nycrc.json`): 90% stmts/fns/lines, 86% branches.
  Per-suite Jest floors (`package.json` + `test/jest-e2e.json`) are fast
  anti-regression only; never raise them to 90. See [`./testing.md`](./testing.md)
  for the full policy and the branch-exclusion rationale.
- **TypeScript is pinned to 5.x on purpose.** The codebase is not TS6-ready
  (a TS6/ESLint10 bump was reverted because it surfaced ~1167 hidden errors).
  Don't blindly accept Dependabot bumps for `typescript`/`eslint` majors — they
  require a dedicated migration.

## 9. Test quality bar

Every test — unit or e2e — must meet this checklist. A test that fails it is not
counted toward coverage targets and should be reworked.

### Assert observable behavior, not implementation

- **Assert HTTP status + response body**, or (for unit tests) function return
  value / thrown error. Never assert that an internal method was called or that a
  mock received specific arguments — those assertions couple the test to the
  implementation, not the contract.
- **Name each test's failure mode explicitly.** The `it`/`test` string should
  read as a sentence describing what breaks and what the expected outcome is:
  `'returns 422 when invoice is already POSTED'`, not `'handles posted invoice'`.
- **One meaningful assertion per scenario.** Test the status code *and* the
  `body.code` (domain error code) where applicable; don't stop at status alone,
  and don't assert every field of a large response body in a single test.

### No mock-theater on integration code

- **E2E specs use the real NestJS app and a real Testcontainer Postgres.** Do not
  mock `PrismaService`, `JwtService`, or any other infrastructure dependency in an
  e2e spec — mock-theater at this layer validates the mock, not the system.
  Override the DB URL via `bootstrapTestApp({ db })` (which calls
  `makePrismaOverride(db.url)` internally) and let the real code run.
- **Unit specs mock only the minimum.** For pure-logic services that accept a
  `PrismaService`, mock only the specific `client.<model>.<method>` calls the path
  under test touches, and cast the partial with `as never`. Do not mock an entire
  service module or use `jest.mock()` on NestJS providers in unit specs.
- **Do not extract logic from integration services** (year-end-close, auth,
  refresh-token, interceptors, guards) just to make them unit-testable. If the
  code needs the real DB/pipeline to be meaningful, it belongs in an e2e spec.

### Where to write each test

| Scenario | Tier | Template |
| --- | --- | --- |
| Pure function (money math, date helper, signing, tax calculation) | **Unit** | `src/reporting/income-statement.service.spec.ts` |
| Service guard (domain error, status 4xx) | **E2E** | any `test/*.e2e-spec.ts` |
| HTTP shape + envelope validation | **E2E** | any `test/*.e2e-spec.ts` |
| Concurrency race / advisory-lock path | (b)-exclusion — do not write | — |
| DTO-shadowed branch (400 before service) | (b)-exclusion — do not duplicate | — |

E2e specs **must** use `bootstrapTestApp()` from `test/e2e-helpers.ts` — never
hand-roll the module+app setup. See [`./testing.md`](./testing.md) for the full
bootstrap pattern.

## 9. OpenAPI contract

- **Every 2xx response body is a NAMED DTO** (`*ResponseDto` / `*Dto`) declared
  via `@ApiOkResponse({ type: ... })` / `@ApiCreatedResponse({ type: ... })` —
  never an inline/anonymous schema. (`204` and the `text/plain` `/metrics`
  endpoint are the only exceptions.)
- **A guard test enforces this.** `src/common/openapi/openapi-contract.spec.ts`
  fails if any 2xx response lacks a non-empty named body schema in
  `docs/api/openapi.json`.
- **Regenerate the spec when the contract changes.** Run
  `npm run openapi:export` (builds, then runs `src/scripts/export-openapi.ts`
  in DB-free preview mode) and commit the updated `docs/api/openapi.json`. Note
  the export bootstrap calls `enableVersioning` too — see §3.

---

## PR checklist

- [ ] Money via `Money`; serialized as strings — no float arithmetic.
- [ ] Threw a typed domain error; no hand-built error responses, no leaked
      internals.
- [ ] Route under `/v1`; correct `@Public()`/`@Roles()`; `ParseUUIDPipe` on
      `:id`; request DTO with validation; lists return the pagination envelope.
- [ ] Money-mover / create handler has `@IdempotentWrite()`.
- [ ] Migration SQL hand-authored; `db:generate` run after schema edits.
- [ ] Used the extended client + `softDelete`; raw SQL filters
      `deleted_at IS NULL`; no double-filtering on model reads.
- [ ] System accounts resolved by `account.role`, not code strings.
- [ ] 2xx responses are named DTOs; `openapi.json` regenerated if the contract
      changed.
- [ ] `npm run verify` is green.
