# Meaningful Unit Coverage — Reporting Services — Design

**Status:** Approved (brainstorming) — 2026-06-25
**Goal:** Lift unit coverage with *solid, bug-catching* unit specs for the reporting
services that are genuinely unit-testable — `cash-flow` and `balance-sheet` — without
adding mock-theater on integration code.

## Context & the constraint that shaped scope

Current unit coverage is **31.7 / 31.3 / 27.7 / 31.0** (stmts/branch/funcs/lines). That
is low *by design*: ~60% of `src/` is integration glue (controllers, guards, the
idempotency/metrics interceptors, `year-end-close.service`, auth/refresh-token, and the
transactional document/ledger services) whose real bugs live in Prisma `$transaction`
semantics, SQL, locking, and concurrency — invisible to a mocked unit test. Those are
correctly guarded by the e2e suite against a real Postgres. The **merged unit∪e2e gate**
(`npm run test:cov:all`, `.nycrc.json` 90/86/90/90, achieved 95/86/96/95) is the real
defect guard and is already in place. **Unit-90%-global is explicitly NOT the goal** — it
would require mocking Prisma/JWT on integration code, which contradicts "catch bugs early."

The one genuinely-meaningful unit pocket is the reporting services that delegate all DB
work to `BalancesService` and do **pure assembly** on the returned rows. `income-statement.service`
already has such a spec (`income-statement.service.spec.ts`). Verified which of the rest
qualify:

| Service | Deps | Own raw SQL? | Unit-testable? |
| --- | --- | --- | --- |
| `cash-flow` | `BalancesService` | none | **yes** |
| `balance-sheet` | `BalancesService` + `CompanyService` | none | **yes** |
| `aging` | `PrismaService` | **yes** (correlated subquery) | no → e2e (already covered) |
| `general-ledger` | `Prisma` + `Balances` + `Accounts` | **yes** (GL query) | no → e2e (already covered) |

`aging` / `general-ledger` run their own SQL — the architecture review flagged these as
irreducibly e2e, and the coverage work already gave them e2e tests. Unit-testing them
means mocking *around* the SQL (the trap). They are out of scope.

## Scope — two unit specs

### 1. `src/reporting/cash-flow.service.spec.ts`
`new CashFlowService(mockBalances)`. Mock `balances.movementsBetween(from,to)` and
`balances.balancesAsOf(date)` (called twice — `dayBefore` and `to`; use distinct
mock returns so `kasAwal ≠ kasAkhir`). Cover the real branches/invariants of `generate`:
- `netIncome` = Σ cash-effect (`credit − debit`) over non-CASH P&L rows (REVENUE/EXPENSE).
- `bucket()` → INVESTING / FINANCING / OPERATING, including the **`NONE` → OPERATING** default.
- the **`amt.isZero() → continue`** skip (a zero-effect balance-sheet account is excluded).
- `operating = netIncome + OPERATING.total`; `investing`/`financing` section totals.
- `netChange = operating + investing + financing`.
- `cashBalance` = Σ over `role === 'CASH'` rows of `debit − credit` (kasAwal/kasAkhir).
- **`reconciles = kasAwal + netChange === kasAkhir`** — assert both a true and a non-reconciling case.

### 2. `src/reporting/balance-sheet.service.spec.ts`
`new BalanceSheetService(mockBalances, mockCompany)`. Mock `company.fiscalYearFor(asOf)`,
`company.fiscalYearBounds(fy)` → `{ start }`, `balances.balancesAsOf(asOf)`, and
`balances.movementsBetween(fyStart, asOf)`. Use the **real** `naturalSide` (it is pure —
do not mock it). Cover:
- `group()` — per-subtype grouping + `naturalSide` signing (include a **contra** account,
  e.g. Akumulasi Penyusutan, so the contra path is exercised) + subtotals.
- assets / liabilities / equity split by `type`.
- **synthetic `CURRENT_EARNINGS`** equity line = cumulative Σ(`credit − debit`) over P&L rows.
- **`currentYearEarnings`** sub-figure from the `movementsBetween(fyStart, asOf)` mock.
- `totalEquity = eq.total + cumulativeEarnings`.
- **`balanced = assets.total === liabilities.total + totalEquity`** — assert a balanced case
  and an unbalanced one.

## Quality bar (binding)
- Each test asserts the **report OUTPUT** (the returned numbers / lines / `reconciles` /
  `balanced` flags) — never mock-interaction counts. Mock only the data-source deps
  (`BalancesService`, `CompanyService`); use the real pure helpers (`Money`, `naturalSide`).
- Each test carries a one-line note of the failure mode it guards.
- Follow the `income-statement.service.spec.ts` pattern (plain jest, `new Service(mocks)`).

## Enforcement
- Add jest per-path `coverageThreshold` keys at **90/90/90/90** for the three unit-tested
  reporting services (`cash-flow.service.ts`, `balance-sheet.service.ts`,
  `income-statement.service.ts`) so they cannot regress.
- **Bump the unit global `coverageThreshold`** (package.json `jest`) from 22/18/18/22 to the
  new achieved floor (anti-regression only — NOT to 90).
- The merged gate (`.nycrc.json`) is untouched; it ticks up slightly. `npm run verify` must
  stay green.

## Non-goals
- No unit tests on `aging` / `general-ledger` (own raw SQL → e2e).
- No unit-90%-global; no mocking Prisma/JWT on integration glue.
- No logic extracted out of any service to make it unit-testable.

## Success criteria
- `cash-flow.service.spec.ts` + `balance-sheet.service.spec.ts` added; each service ≥ 90%
  on all four metrics; per-path thresholds enforce it.
- Unit global floor bumped to the achieved level (expected ~high-30s/low-40s, up from 31.7).
- Every test maps to a named failure mode; no mock-interaction assertions.
- `npm run verify` green (unit + e2e + merged gate).
