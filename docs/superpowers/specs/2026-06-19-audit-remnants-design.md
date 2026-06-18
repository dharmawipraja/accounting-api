# Audit Remnants (OPS-RES-2 + OPS-CFG-3 + OPS-TEST-2) — Design

- **Date:** 2026-06-19
- **Status:** Approved (design); pending implementation plan
- **Source:** The last actionable in-repo remnants of `docs/production-readiness-audit-2026-06-17.md`, surfaced by an independent code-verification pass (2026-06-19) that confirmed every Critical/High/Medium finding already fixed in source. These three are Low/Medium, previously deferred.
- **Type:** One small runtime addition (timeout interceptor), one doc/config fix (`.env.example`), and a focused unit-test expansion. No change to existing app behavior on the happy path.

## 1. Scope

| Item | Sev | Nature |
|------|-----|--------|
| OPS-RES-2 | ⚪ Low | per-request timeout interceptor (new global interceptor + env var) |
| OPS-CFG-3 | ⚪ Low | document 5 optional env vars in `.env.example` |
| OPS-TEST-2 | 🟡 Med | focused unit specs for the **pure** logic of the core financial engine + raise the unit coverage floor |

**Out of scope:** operator-activation items (OPS-DB-1/OPS-OBS-1/OPS-CI-1 — scaffolding done, need secrets); not-a-bug/not-actionable items (OPS-DB-2 already-applied migration, OPS-DB-3, NEW-2); anything requiring a live secret to merge.

## 2. OPS-RES-2 — per-request timeout interceptor

**New** `src/common/interceptors/request-timeout.interceptor.ts`: a global `RequestTimeoutInterceptor` that applies RxJS `timeout({ each: ms })` to the handler stream; on `TimeoutError` it throws `RequestTimeoutException` (**408**, an `HttpException` the existing `AllExceptionsFilter` renders cleanly into the standard envelope). Any other error passes through unchanged.

- **Config:** new optional `REQUEST_TIMEOUT_MS` in `src/config/env.validation.ts` (`@IsOptional @IsInt @Min(1000)`), default **30000** when unset. Aligned at/just under the server's `requestTimeout=30_000` (`main.ts`) so the app returns a clean 408 envelope rather than the socket being cut.
- **Probe bypass:** skip `/health`, `/ready`, `/metrics` (long-running scrapes/liveness must not 408). Implement by checking the request path in the interceptor (these are `@Version(VERSION_NEUTRAL)` operational routes) — if the path is one of those, pass through without the timeout operator.
- **Registration:** `APP_INTERCEPTOR` provider in `app.module.ts`, reading `REQUEST_TIMEOUT_MS` (via `process.env` with the default, consistent with how other runtime knobs are read).
- **No behavior change** for requests that finish under the limit (the overwhelming majority); only a slow (>30s) request now gets a clean 408 instead of a dropped socket.

## 3. OPS-CFG-3 — `.env.example`

Add the 5 optional vars (commented, with one-line descriptions), matching the validated `EnvVars` and the deploy.md references:
- `METRICS_TOKEN` — bearer token gating `/metrics` (fail-closed in prod if set).
- `SENTRY_DSN` / `SENTRY_ENVIRONMENT` / `SENTRY_RELEASE` — DSN-gated error reporting.
- `THROTTLE_LIMIT` (default 300) / `THROTTLE_LOGIN_LIMIT` (10) / `THROTTLE_REFRESH_LIMIT` (30) — per-min rate limits.
- `ENABLE_SWAGGER` — `true` to expose `/docs` in production.
- `GRAFANA_ADMIN_PASSWORD` — for the optional `docker-compose.monitoring.yml` overlay.
- (Include `REQUEST_TIMEOUT_MS` too, added by §2.)

Doc-only; no code impact.

## 4. OPS-TEST-2 — focused unit specs (pure logic only)

**Principle:** unit-test the genuinely *pure* logic; leave SQL-coupled code to the e2e suite that already exercises real Postgres. No brittle full-DB-mock duplication.

1. **`src/tax/tax.service.spec.ts` (new) — the core win.** `TaxService.calculate`'s only dependency is `prisma.client.taxCode.findMany`; mock it to return fixed tax codes, then unit-test the engine over in-memory line input: PPN output/input, PPh withholding, **per-code rupiah rounding**, settlement amount, the balance assertion, and the guards (duplicate tax-code-ids in a line → 422; unknown tax code → 422; non-positive settlement → 422). No tax-engine unit spec exists today; this is the highest-value addition.
2. **PostingService balance validation.** Unit-test `assertBalanced`: balanced multi-line passes; debits≠credits → `UnbalancedEntryError`; a line with both debit and credit (or neither) is rejected. If `assertBalanced` is private, test it via the fail-fast path of a public method that runs it before any DB call (`preparePosting` with mocked `company`/`periods` deps), asserting the `UnbalancedEntryError` is thrown before any DB interaction — OR expose it as an internal pure helper. The implementer picks the cleaner of the two; the assertion (debits must equal credits) is what matters.
3. **BalancesService signing.** Unit-test the TYPE/`normalBalance`-based signing in `toRow` (DEBIT → `debit − credit`; else `credit − debit`) by feeding mocked `$queryRaw` raw rows through the public primitive and asserting the signed `balance`. Covers the contra/sign-convention logic without re-testing the SQL.
4. **Year-end close — explicitly left to e2e.** Its net-income / P&L-zeroing logic is DB-coupled (`movementsBetween`); the existing `close.e2e-spec.ts` + `close-out-of-order.e2e-spec.ts` cover it. A unit mock would restate the implementation, not validate it. Documented as a deliberate boundary.
5. **Raise the unit coverage floor (ties off OPS-CI-2).** The Track-A `coverageThreshold` was set deliberately low (18/12/14/18, "raise later"). After the new specs land, measure unit coverage and ratchet the floor up to just below the new measured level — the regression floor now reflects the added tests.

## 5. Testing & gates

- Parts 2–4 are unit-only; Part 1 adds a runtime interceptor exercised by a focused unit test (fake timers) plus the existing e2e (the app still boots; sub-timeout requests unaffected).
- Per-task gate: `npm run db:generate` (cheap), `typecheck` 0, `lint:ci` 0, the task's unit tests; the coverage-floor task runs `npm run test:cov` and confirms it passes at the raised floor.
- Final `npm run verify` green (acknowledge the known environmental e2e flakiness — confirm any failure in isolation).
- **No app behavior change** except a slow (>`REQUEST_TIMEOUT_MS`) request now returns 408.

## 6. Sequencing

The unit specs (Part 4 items 1–3) land BEFORE the coverage-floor bump (Part 4 item 5), so the floor is measured with the new tests present (same discipline as the Track-A floor). Parts 1–3 are independent.

## 7. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Timeout interceptor 408s a legitimately-slow request (e.g. a heavy report) | Default 30s matches the existing server cap; configurable via `REQUEST_TIMEOUT_MS`; probes bypassed |
| `assertBalanced` is private → awkward to unit-test | Test via the fail-fast public path (pre-DB) or expose as a pure helper — implementer's call; the invariant is the goal |
| Tax-engine unit test drifts from real tax-code data shape | Mock returns the real `TaxCode` shape (kind/nature/rate/settlementAccountId); the math is what's asserted, e2e still covers the DB read |
| Raised coverage floor false-trips later | Ratchet to *below* the new measured level (regression floor, not target) |
| Timeout interceptor interferes with the idempotency/audit interceptors | Order it so it wraps the handler; it only adds `timeout()` to the stream and rethrows — no interaction with the others' logic |

## 8. Out of scope
OPS-DB-1/OPS-OBS-1/OPS-CI-1 (operator activation of shipped scaffolding); OPS-DB-2 (already-applied migration — not editable); OPS-DB-3 / NEW-2 (not bugs); full unit coverage of the SQL-coupled posting/close internals (e2e owns those). Each, if ever pursued, is its own effort.
