# Account Role Flags — Design (Deepening D)

- **Date:** 2026-06-18
- **Status:** Approved (design); pending implementation plan
- **Source:** §3 "Architecture & dead code" → Deepening **D** of `docs/production-readiness-audit-2026-06-17.md` (deferred from the architecture-cleanup effort).
- **Type:** Behavior-changing (fixes a latent correctness bug); behavior-preserving for the current seeded chart.

## 1. Motivation

Six "system-account roles" are currently identified by **hardcoded code strings** scattered across reporting/posting/close. The cash one is a **latent correctness bug today**: `cash-flow.service.ts` hardcodes `CASH_CODES = {'1-1000','1-1100'}`, so a new bank/cash account whose code isn't in that set is **silently dropped from the cash-flow statement** (its movements neither appear as cash nor reconcile). The other five couple posting/close/reporting to specific code strings, so any chart re-numbering silently breaks them.

This replaces the by-code coupling with an explicit `role` on the `Account` model, so lookups are role-based and a correctly-flagged account always participates regardless of its code.

The six roles and their current code coupling:

| Role | Current code(s) | Used by | Cardinality |
|------|-----------------|---------|-------------|
| `CASH` | `1-1000`, `1-1100` | cash-flow statement (**the bug**) | set (many) |
| `AR_CONTROL` | `1-1200` | AR control lookup (`findControlAccountId`) | singleton |
| `AP_CONTROL` | `2-1000` | AP control lookup | singleton |
| `RETAINED_EARNINGS` | `3-2000` | year-end close (Laba Ditahan) | singleton |
| `OPENING_BALANCE_EQUITY` | `3-9000` | opening balances (journal) | singleton |
| `TAX_EXPENSE` | `5-9000` | income-statement separation | singleton |

## 2. Goals / Non-goals

**Goals**
- Add an explicit `AccountRole` to `Account`; replace all six by-code lookups with role-based ones.
- Behavior-preserving for the current seeded chart (role-based lookups return exactly the accounts the code lookups did).
- Fix the cash-flow bug: any account flagged `CASH` participates, regardless of code.
- DB-enforce singleton roles; surface a clean 409 when a singleton role is double-assigned.
- Characterization tests pin the affected reports/flows BEFORE the refactor; a new test proves the bug fix.

**Non-goals**
- No role-reassignment endpoint (roles set via seed + create-DTO only; internal-only scope).
- `cashFlowCategory` (already a proper enum for OPERATING/INVESTING/FINANCING grouping of non-cash accounts) is unchanged.
- Tax-code → settlement-account references (stored on `TaxCode` by id, not hardcoded constants) are out of scope.
- Candidate C (TOCTOU `FOR SHARE`) is a separate spec.

## 3. Design decisions

1. **Single nullable `role` enum on `Account` + one partial-unique index** (chosen over six booleans / a mapping table). Cash is a set, the other five are singletons; a single column with a partial unique index excluding `CASH` handles both. Most accounts have `role = NULL`.
2. **Internal-only scope.** Roles assigned by the seed (backfill) + an optional `role` on the create-account DTO. No reassignment endpoint.
3. **Reporting filters by role require carrying `role` on the balance/movement row projections** (cash-flow and income-statement filter over `BalancesService` rows, not `Account` directly), so those raw-SQL projections + row interfaces gain `role`.

## 4. Schema + migration + backfill

**Schema (`prisma/schema.prisma`):**
```prisma
enum AccountRole {
  CASH
  AR_CONTROL
  AP_CONTROL
  RETAINED_EARNINGS
  OPENING_BALANCE_EQUITY
  TAX_EXPENSE
}
// on model Account:
role AccountRole? @map("role")
```

**Hand-authored migration** (`prisma/migrations/<ts>_account_role/migration.sql`):
1. `CREATE TYPE "AccountRole" AS ENUM (...)`.
2. `ALTER TABLE accounts ADD COLUMN role "AccountRole"` (nullable, default NULL).
3. Partial unique index enforcing the five singletons while allowing many `CASH` and many `NULL`:
   ```sql
   CREATE UNIQUE INDEX accounts_singleton_role
     ON accounts (role)
     WHERE role IS NOT NULL AND role <> 'CASH';
   ```
4. **Backfill** (behavior-preserving for the existing chart):
   ```sql
   UPDATE accounts SET role = 'CASH'                   WHERE code IN ('1-1000','1-1100');
   UPDATE accounts SET role = 'AR_CONTROL'             WHERE code = '1-1200';
   UPDATE accounts SET role = 'AP_CONTROL'             WHERE code = '2-1000';
   UPDATE accounts SET role = 'RETAINED_EARNINGS'      WHERE code = '3-2000';
   UPDATE accounts SET role = 'OPENING_BALANCE_EQUITY' WHERE code = '3-9000';
   UPDATE accounts SET role = 'TAX_EXPENSE'            WHERE code = '5-9000';
   ```

**Seed (`chart-of-accounts.seed.ts`):** add `role` to the six entries so fresh installs are correct; the seed insert writes `role`.

## 5. Lookup switches (code → role)

Each switch preserves the site's existing missing-account handling exactly.

- **`cash-flow.service.ts`** — `CASH_CODES.has(r.code)` → `r.role === 'CASH'` for both the cash filter and the `nonCash` complement. **This is the bug fix.** `cashFlowCategory` bucketing of non-cash accounts is untouched. Requires `role` on the movement-row projection (see the `BalancesService` bullet below).
- **`income-statement.service.ts`** — `r.code === TAX_EXPENSE_CODE` / `!==` → `r.role === 'TAX_EXPENSE'` / `!==`. Requires `role` on the balance-row projection.
- **`BalancesService` (`balances.service.ts`)** — add `a.role` to the raw-SQL `SELECT`/`GROUP BY` for the row sets consumed by cash-flow and income-statement, and add `role` to the corresponding row interface(s). (This is the enabling change for the two filters above.)
- **`document-helpers.ts`** — `findControlAccountId(prisma, code)` becomes role-based (`findControlAccountId(prisma, role: AccountRole)` doing `findFirst({ where: { role } })`). Sales/purchase/payments pass `'AR_CONTROL'` / `'AP_CONTROL'`. Drop the `AR_CONTROL_CODE`/`AP_CONTROL_CODE` constants.
- **`year-end-close.service.ts`** — retained-earnings lookup `findFirst({ where: { role: 'RETAINED_EARNINGS' } })`; **preserve the find-or-THROW** (`ValidationFailedError('Laba Ditahan account missing from chart', { role: 'RETAINED_EARNINGS' })`). Drop `RETAINED_EARNINGS_CODE`.
- **`journal.service.ts`** — replace `(await this.accounts.listAll()).find(a => a.code === OPENING_BALANCE_EQUITY_CODE)` with `findFirst({ where: { role: 'OPENING_BALANCE_EQUITY' } })`; preserve the find-or-throw. (If this was the only `listAll()` consumer in journal, simplify accordingly; `listAll()` itself stays — tax-codes still uses it.) Drop `OPENING_BALANCE_EQUITY_CODE`.

After the switches, delete the six now-dead code constants and confirm no other references remain.

## 6. New-account role assignment + singleton enforcement

- Optional `role?: AccountRole` on the create-account DTO (`@IsOptional() @IsEnum(AccountRole)`).
- Assigning a second holder of a singleton role violates `accounts_singleton_role` → Prisma `P2002` → routed through the existing **`mapUniqueViolation`** seam → **409** ("That account role is already assigned"). (CASH never conflicts.) Reuses the §3 seam.

## 7. Testing (characterization-first — the safety net)

The five affected flows already have e2e coverage (`reporting-cashflow`, `reporting-aging`, `close`, `reporting-statements`, opening-balances). Plan order:
1. **Characterization first:** confirm/strengthen those specs to pin the current numbers (cash-flow sections + cash reconciliation; AR/AP aging↔control; retained-earnings close; opening-balance equity; income-statement tax-expense line) — so the refactor must keep identical output.
2. Apply the schema + migration + backfill + lookup switches.
3. Suite stays green (behavior-preserving for the seeded chart).
4. **New bug-fix test:** seed a SECOND cash account with a non-legacy code (e.g. `1-1150`, `role = CASH`), post cash movements through it, and assert it appears in the cash-flow statement and reconciles — proving the account that the old `CASH_CODES` set would have silently dropped is now included.
5. Add a unit/e2e test asserting the singleton 409 (creating a second `AR_CONTROL` account → 409 via `mapUniqueViolation`).

## 8. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Backfill misses an account / wrong role → behavior change | Backfill maps the exact current codes; characterization tests catch any divergence |
| Reporting rows don't carry `role` → filter silently empty | The `BalancesService` projection change is a prerequisite; characterization tests assert non-empty cash/tax lines |
| Partial-unique index portability | Standard Postgres partial unique index; e2e runs on `postgres:16` via Testcontainers |
| A singleton role unassigned at runtime (0 holders) | Each site keeps its existing find-or-throw; behavior identical to today's missing-by-code case |
| Migration ordering | Hand-authored, applied via `prisma migrate deploy` in e2e — covered by the suite |

## 9. Out of scope
`cashFlowCategory`; role-reassignment endpoint; tax-code settlement-account references; candidate C (TOCTOU). Each deferred item, if pursued, gets its own spec.
