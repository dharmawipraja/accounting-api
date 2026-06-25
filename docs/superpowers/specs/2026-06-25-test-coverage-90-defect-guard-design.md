# Test Coverage to 90% as a Defect Guard — Design

**Status:** Approved (brainstorming) — 2026-06-25. Refined after the Step-0 gap
analysis (merged-coverage gate).
**Goal:** Raise coverage to 90% in a way that makes the suites stronger *defect
guards*, with zero tests written merely to color lines.

## Problem & current state (measured)

Two suites measure different surfaces:

- **Unit** (`jest`, `rootDir: src`, no DB): actual **31.2 / 29.8 / 27.3 / 30.5**
  (stmts/branch/funcs/lines); floor 22/18/18/22. Covers the pure/algorithmic
  modules at high fidelity (most at **100%**), nothing integration-heavy.
- **E2E** (`jest -c test/jest-e2e.json`, testcontainers + real Postgres): actual
  **89.1 / 71.1 / 90.4 / 89.6**; floor 84/62/84/84.

**Key finding from the gap analysis:** the e2e *global* number is contaminated.
~15 pure/infra modules show low e2e branch coverage (`fiscal-year` 50, `money` 50,
`exception-status` 30, `map-unique-violation` 0, `cors-origins` 0, `sentry-scrub` 0,
`metrics-token.guard` 20, `env.validation` 75, `all-exceptions.filter` 45, …) **but
are at or near 100% branch coverage in the unit suite.** They are fully guarded — by
unit tests, not e2e. Driving the *e2e* global number to 90 would force duplicate e2e
tests for code already at 100% unit coverage — the exact meaningless tests we want to
avoid.

The genuine gaps are in the **integration services**, where e2e is the right guard:
`taxed-document.service` (47), `purchase-bills.service` (0 — thin delegator),
`payments.service` (72), `journal.service` (66), `tax-codes.service` (62),
`year-end-close.service` (71), `periods.service` (60), `accounts.service` (78),
`business-partners.service` (69), `posting.service` (77), `closing.controller` (0),
`document-lifecycle.service` (60), `payment-targets` (78), `aging.service` (67). The
uncovered branches there are real behavior — e.g. `allocations.length === 0 → 422`,
`!partner.isActive → 422`, partner-not-customer/supplier `→ 422`, cash-not-postable
`→ 422`, non-positive allocation `→ 422`, edit-non-`DRAFT` `→ 422`, tax-rate-out-of-
range / `>6dp` / account-not-postable `→ 422`.

## Principle (the spine)

**The defect guard is MERGED (unit ∪ e2e) coverage ≥ 90% global**, branches
ratchet-to-meaningful. A branch covered by *either* suite counts as guarded — pure
code via unit, integration code via e2e — so we never write a duplicate test just to
satisfy one suite's number. One honest number.

Each suite keeps a fast per-suite *floor* (anti-regression, fast local feedback), but
**the merged report is the real 90% gate.**

**Every test maps to a concrete failure mode it would catch.** No line-coloring; no
mocking Prisma/JWT to fake-unit-test integration code.

**"Ratchet-to-meaningful":** 90 is the aim for stmts/funcs/lines. For branches we
write a test for every genuinely-reachable branch (error/guard/edge/financial-
invariant), then set the merged floor to the level that *honestly* achieves (may land
88–92). Defensive/unreachable branches (`?? fallback`, rethrow, framework edge,
@Cron-only purge bodies) are left uncovered and documented.

## Coverage tooling (the merge)

1. Both suites already produce coverage; ensure each emits the `json` reporter:
   - unit → `coverage/coverage-final.json`
   - e2e  → `coverage-e2e/coverage-final.json`
2. Add `nyc` (devDependency). A `coverage:merge` step copies both `coverage-final.json`
   into `.nyc_output/`, then `nyc report` (merged HTML/text) + `nyc check-coverage`
   enforces the merged global thresholds.
3. A new `test:cov:all` script runs unit-cov → e2e-cov → merge+check. `npm run verify`
   calls it. The per-suite `coverageThreshold` floors remain as fast anti-regression
   gates; the merged `check-coverage` is the 90% defect gate.
4. `export-openapi.ts` (a build script, not runtime) is excluded from coverage
   collection.

## Workstream 1 — close the integration branch gaps (the bulk)

### Step 0 — Gap analysis artifact (the backlog)
From the e2e `coverage-final.json`, produce a committed, categorized table: for each
integration file with a branch gap, list each uncovered branch as **(a) real behavior
→ test** (with the one-line failure mode + expected status) or **(b) defensive/
unreachable → leave** (with reason). The (a) rows, grouped by module area, are the
implementation backlog.

### Steps 1..N — write the (a) e2e tests, batched by area
Areas: invoicing (sales/purchase/taxed-document/payments/partners), ledger
(posting/journal/periods/accounts/balances), tax-codes, close (year-end/closing),
reporting (aging). Each test via `bootstrapTestApp()`, asserts HTTP status + body,
carries a one-line failure-mode note. Batches are independently reviewable.

## Workstream 2 — unit gap-fill (small; mostly already done)

The pure modules are already ~100% unit. The only missing spec is
`src/common/dates/parse-date.ts` (add `parse-date.spec.ts`). Fill any pure-module
branch < 90 that the merged gate exposes (e.g. `all-exceptions.filter` unit branch 72,
`idempotency.service` unit branch 80 — only the genuinely-reachable branches). No
per-path thresholds — the merged gate subsumes them.

**Guardrail (explicit non-goal):** do **not** extract logic out of integration
services (`year-end-close`, `auth`, `refresh-token`, interceptors, guards) to make it
unit-testable. The architecture review rejected "extract a pure function just for
testability when the real risk is in how it's called." Those stay e2e-guarded.

## Enforcement (the ratchet)
`npm run verify` runs `test:cov:all`; the merged `nyc check-coverage` fails CI on any
regression below the ratcheted floors → coverage only goes up.

## Quality bar (review checklist)
- Asserts **observable behavior** (HTTP status+body, or function return/throw) — never
  internal calls / mock-interaction counts.
- No mocking Prisma/JWT to fake-unit-test integration code.
- Prefers an uncovered **branch** over a duplicate happy path.
- Each test carries a one-line note of the failure mode it guards.
- e2e via `bootstrapTestApp()`; pure unit specs follow `income-statement.service.spec.ts`.

## Phasing
The integration (a)-backlog is the large chunk; the plan sizes it from the Step-0
artifact and batches by module area. The tooling task lands first (so the merged
number is visible), Workstream 2 is a single small task, the ratchet is last.

## Non-goals
- No global *unit* 90% and no global *e2e* 90% in isolation (each would force
  meaningless duplication); the MERGED number is the gate.
- No tests for defensive/unreachable branches (documented exclusions).
- No coverage of DTOs / `main.ts` / `*.module.ts` / `export-openapi.ts`.
- No extraction of logic from integration services purely for coverage.

## Success criteria
- Merged `check-coverage`: statements/functions/lines = 90; branches = honest achieved
  (≥ current merged, target 90), ratcheted in CI.
- `parse-date.spec.ts` added; the categorized (b)-exclusion list committed.
- Every added test maps to a named failure mode; no duplicate/line-coloring tests.
- `npm run verify` green.
