# Test Coverage to 90% as a Defect Guard — Design

**Status:** Approved (brainstorming) — 2026-06-25
**Goal:** Raise unit and e2e coverage toward 90% in a way that makes the suites
stronger *defect guards*, with zero tests written merely to color lines.

## Problem & current state

Two coverage gates measure different things:

- **Unit** (`jest`, `rootDir: src`, no DB): actual **31.2 stmts / 29.8 branch /
  27.3 funcs / 30.5 lines**; `coverageThreshold.global` floor **22/18/18/22**. The
  unit suite intentionally covers only a subset of `src/` — pure/algorithmic
  modules and a few services. The 0%-unit files are integration-heavy and
  e2e-covered: controllers, `jwt-auth`/`roles` guards, `jwt.strategy`,
  `idempotency.interceptor`, `year-end-close.service` (212 lines), `auth.service`,
  `refresh-token.service`, the purge services. (DTOs, `main.ts`, `*.module.ts` are
  excluded by config.)
- **E2E** (`jest --config test/jest-e2e.json`, testcontainers + real Postgres):
  `coverageThreshold.global` floor **84/62/84/84**. This is the real behavioral
  coverage. **Branches (62) are the conspicuous gap.**

Naively forcing the **unit** suite to 90% global would require unit-testing
controllers/guards/interceptors/`year-end-close` by mocking Prisma/JWT — brittle,
implementation-coupled tests that directly contradict the "no meaningless tests"
goal.

## Principle (the spine)

Two suites, two jobs, one rule:

1. **E2E (real DB) = the behavioral defect guard → 90% global**, ratchet-to-meaningful
   on branches.
2. **Unit (pure logic) = the fast algorithmic guard → 90% per-path** on the modules
   where isolated tests are the *right* tool; the global unit floor stays a
   regression ratchet.
3. **Every test maps to a concrete failure mode it would catch.** No test exists to
   color a line; no asserting-mocks on integration code.

**"Ratchet-to-meaningful":** 90 is the aim. We write a test for every
genuinely-reachable branch (error / guard / edge / financial-invariant), then set
the floor to the level that *honestly* achieves — which may land at 88 or 92 for
branches. We never write a test solely to cover a defensive/unreachable branch
(`?? fallback`, rethrow, framework edge); those are left uncovered and documented.

## Workstream 1 — E2E to 90% (branch-driven; the bulk of the work)

### Step 0 — Gap analysis (produces the test backlog)

Run `npm run test:e2e:cov`, take the per-file uncovered branch/line report, and
classify every uncovered branch as:

- **(a) Real behavior worth guarding** → becomes a test. Expected categories:
  error responses (404 / 409 / 422), role-guard 403s, validation 422s
  (`forbidNonWhitelisted`, `IsMoneyString`, UUID, date), idempotency replay
  (original response) / in-flight 409 / key-reuse 422, over-allocation 409,
  post-into-closed-period and post-into-closed-year guards, reversal-of-already-
  reversed 422, tax non-positive-settlement 422, segregation-of-duties 403,
  `from > to` 422, not-found 404, pagination bounds, fuzzy-search `?q=`.
- **(b) Defensive / unreachable** → left uncovered, listed in the PR with a
  one-line reason each (rethrows, `?? fallbacks`, framework edges).

The (a) list, grouped by module, **is** the implementation backlog. Output of Step 0
is a written, categorized table.

### Steps 1..N — Write the (a) tests, batched by module area

Each via `bootstrapTestApp()`. Each test asserts HTTP status + relevant body fields
and carries a one-line note of the defect it guards. Batches (auth, invoicing,
ledger/posting, close, reporting, common/idempotency) are reviewable independently.

### Final — Ratchet the e2e threshold

Set `test/jest-e2e.json` `coverageThreshold.global` to the achieved level:
statements / functions / lines → a clean **90**; branches → the honest achieved
number (target 90, never below the current 62). CI then forbids regression.

## Workstream 2 — Unit 90% per-path on the pure/algorithmic modules

### Target paths (unit tests are the right tool here)

Pure or near-pure, branch-rich, fast to test in isolation:

- `src/tax/tax.service.ts` — engine math (per-code rupiah rounding, PPN/PPh kinds,
  dup-code / non-positive-settlement guards)
- `src/common/money/money.ts`, `src/common/money/serialize-money.ts`
- `src/ledger/balances/signing.ts` — `signedNet` (per `normalBalance`), `naturalSide`
  (per `type`, contra-aware)
- `src/common/dates/fiscal-year.ts`, `query-dates.ts`, `parse-date.ts`, `utc-day.ts`
- `src/common/db/sequence.ts` — pure parts of `nextSequenceNumber`
- `src/ledger/posting/assert-balanced.ts`
- `src/common/errors/exception-status.ts`, `map-unique-violation.ts`
- `src/common/prisma/tombstone.ts`
- `src/common/validators/is-money-string.ts`
- `src/reporting/income-statement.service.ts` (already specced) + any report helper
  that is *already* pure

These mostly need lock-in plus gap-filling — pure code is usually already near-complete
in its own spec. Add branch-focused unit specs only where a metric for a path is < 90
(e.g. every tax kind, every normal-balance sign incl. contra, rounding edges,
`from > to`).

### Mechanism

Add `coverageThreshold` per-path keys in the unit jest config (package.json `jest`
block), each at 90 on all four metrics, e.g.:

```jsonc
"coverageThreshold": {
  "global": { "statements": 31, "branches": 29, "functions": 27, "lines": 30 },
  "./src/ledger/balances/signing.ts": { "statements": 90, "branches": 90, "functions": 90, "lines": 90 },
  "./src/tax/tax.service.ts":        { "statements": 90, "branches": 90, "functions": 90, "lines": 90 }
  // ...one entry per target path
}
```

The **global** unit floor is set to its post-work achieved level (≥ current ~31/29/27/30),
anti-regression only — **not** raised to 90 (that would drag in e2e-only code).

### Guardrail (explicit non-goal)

We do **not** extract logic out of integration services (`year-end-close`, `auth`,
`refresh-token`, interceptors, guards) to make it unit-testable. The architecture
review explicitly rejected "extract a pure function just for testability when the
real risk is in how it's called." Those modules stay e2e-guarded.

## Enforcement (the ratchet)

- All thresholds already run inside `npm run verify` (the CI gate). After this work,
  floors = achieved levels; CI fails on any drop → coverage only ratchets up.
- New code that isn't covered fails the relevant gate (existing behavior, now
  stricter).

## Quality bar (review checklist)

- Asserts **observable behavior** (HTTP status + body, or function return/throw) —
  never internal method calls or mock-interaction counts.
- No mocking Prisma/JWT to fake-unit-test integration code (that is e2e's job).
- Prefers an uncovered **branch** over a duplicate happy path.
- Each test carries a one-line note of the failure mode it guards.
- e2e via `bootstrapTestApp()`; pure unit specs follow `income-statement.service.spec.ts`.

## Phasing

The e2e (a)-backlog is the large chunk; the implementation plan sizes it from Step-0
output and batches by module area so each batch is independently reviewable.
Workstream 2 is smaller (mostly lock-in) and can run after, or in parallel.

## Non-goals

- No global unit 90% (forces mock-theater).
- No tests for defensive/unreachable branches (documented exclusions).
- No coverage of DTOs / `main.ts` / `*.module.ts` (excluded by config; correct).
- No extraction of logic from integration services purely for unit coverage.

## Success criteria

- E2E `coverageThreshold.global`: stmts/funcs/lines = 90; branches = honest achieved
  (≥ 62, target 90), ratcheted.
- Each listed unit path: ≥ 90 on all four metrics, enforced per-path.
- Every added test maps to a named failure mode; no defensive-branch theater.
- `npm run verify` green; the categorized (b)-exclusion list documented in the PR.
