# One Home for Normal-Balance Signing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the two distinct account-signing conventions into one tested pure module (`signedNet` by `normalBalance`; `naturalSide` by `type`, contra-aware) and route the five duplicated fragments through it, preserving behavior exactly.

**Architecture:** A new pure module `src/ledger/balances/signing.ts` exports two free functions over the `Money` value object (mirroring the `assert-balanced.ts` pure-helper precedent). Task 1 creates it test-first. Task 2 routes the duplicates: `signedNet` ← `balances.service` (×3) + `general-ledger`; `naturalSide` ← `balance-sheet` + `income-statement`. The two conventions are kept separate — merging them would break the balance sheet for the `Akumulasi Penyusutan` contra account.

**Tech Stack:** NestJS 11, Prisma 7, `Money` (decimal.js wrapper), Jest (unit + e2e against testcontainers — Docker required for e2e).

**Spec:** `docs/superpowers/specs/2026-06-19-report-signing-design.md`

## Global Constraints

- **No behavior change.** Every report and balance output is byte-for-byte identical. The only computational change is `Prisma.Decimal`→`Money` arithmetic at the `signedNet` sites in `balances.service`; `Money` wraps decimal.js at the same precision and the same 4dp `toPersistence()`, so outputs are identical.
- **Two conventions, never merged.** `signedNet(normalBalance,d,c)` = `DEBIT ? d−c : c−d`. `naturalSide(type,d,c)` = `(ASSET|EXPENSE) ? d−c : c−d`. They diverge only for contras (e.g. Akumulasi Penyusutan: ASSET + CREDIT-normal). Do not collapse them into one function.
- **No `any` / no erased typing.** Pure functions, fully typed (`string` params, `Money` in/out).
- **Out of scope — do not touch:** `cash-flow.service.ts` (`cashEffect`/`cashBalance` stay), `balance-sheet`'s `cumulativeEarnings`/`currentYearEarnings` (earnings algorithm), all DTOs/controllers/routes, the Prisma schema, and `balances.service`'s raw SQL + the `totalDebit`/`totalCredit` sums in `trialBalance`.
- **Lint gate:** `npm run lint:ci` (`--max-warnings 0`). Zero warnings.
- **Coverage gate (CI-enforced):** `npm run test:e2e:cov` enforces global 84/62/84/84. The existing report e2e specs are the integration net; the new unit test pins the pure logic.
- **Branch:** `feat/report-signing` (already created off `main` at `8ea655e`).

---

## File Structure

**Create**
- `src/ledger/balances/signing.ts` — pure `signedNet` + `naturalSide`.
- `src/ledger/balances/signing.spec.ts` — unit tests, incl. the contra divergence.

**Modify**
- `src/ledger/balances/balances.service.ts` — `toRow`, `trialBalance`, `accountBalance` use `signedNet`.
- `src/reporting/general-ledger.service.ts` — per-line delta uses `signedNet`.
- `src/reporting/balance-sheet.service.ts` — delete `bsAmount`, call `naturalSide`.
- `src/reporting/income-statement.service.ts` — delete `mag`, call `naturalSide`.

**Unchanged (do not touch):** `cash-flow.service.ts`, all DTOs/controllers, the schema, e2e specs.

---

## Task 1: Pure signing module (`signedNet` + `naturalSide`)

**Files:**
- Create: `src/ledger/balances/signing.ts`
- Test: `src/ledger/balances/signing.spec.ts`

**Interfaces:**
- Produces (consumed by Task 2):
  - `signedNet(normalBalance: string, debit: Money, credit: Money): Money` — `DEBIT ? debit−credit : credit−debit`.
  - `naturalSide(type: string, debit: Money, credit: Money): Money` — `(type==='ASSET'||type==='EXPENSE') ? debit−credit : credit−debit`.
- `Money` is imported from `../../common/money/money` (relative to `src/ledger/balances/`).

- [ ] **Step 1: Write the failing unit test**

Create `src/ledger/balances/signing.spec.ts`:

```ts
import { Money } from '../../common/money/money';
import { signedNet, naturalSide } from './signing';

const M = (v: string) => Money.of(v);

describe('signedNet (by normalBalance)', () => {
  it('debit-normal → debit − credit', () => {
    expect(signedNet('DEBIT', M('1000'), M('300')).toPersistence()).toBe('700.0000');
  });
  it('credit-normal → credit − debit', () => {
    expect(signedNet('CREDIT', M('300'), M('1000')).toPersistence()).toBe('700.0000');
  });
});

describe('naturalSide (by type, contra-aware)', () => {
  it('ASSET → debit − credit', () => {
    expect(naturalSide('ASSET', M('1000'), M('300')).toPersistence()).toBe('700.0000');
  });
  it('EXPENSE → debit − credit', () => {
    expect(naturalSide('EXPENSE', M('500'), M('0')).toPersistence()).toBe('500.0000');
  });
  it('LIABILITY → credit − debit', () => {
    expect(naturalSide('LIABILITY', M('200'), M('900')).toPersistence()).toBe('700.0000');
  });
  it('EQUITY → credit − debit', () => {
    expect(naturalSide('EQUITY', M('0'), M('1000')).toPersistence()).toBe('1000.0000');
  });
  it('REVENUE → credit − debit', () => {
    expect(naturalSide('REVENUE', M('50'), M('1050')).toPersistence()).toBe('1000.0000');
  });
});

describe('the two conventions diverge for a contra account', () => {
  // Akumulasi Penyusutan: type ASSET, normalBalance CREDIT, credit-heavy.
  const debit = M('0');
  const credit = M('800');
  it('naturalSide nets a contra-asset NEGATIVE (reduces assets)', () => {
    expect(naturalSide('ASSET', debit, credit).toPersistence()).toBe('-800.0000');
  });
  it('signedNet reads the contra-asset POSITIVE (its own normal-side balance)', () => {
    expect(signedNet('CREDIT', debit, credit).toPersistence()).toBe('800.0000');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/ledger/balances/signing.spec.ts`
Expected: FAIL — `Cannot find module './signing'`.

- [ ] **Step 3: Implement the pure module**

Create `src/ledger/balances/signing.ts`:

```ts
import { Money } from '../../common/money/money';

/** Net signed so the account's NORMAL side is positive (debit-normal → debit−credit;
 *  credit-normal → credit−debit). The trial-balance / general-ledger convention: every
 *  account's own balance as a positive-on-its-normal-side magnitude. A contra account
 *  (normalBalance opposite its type) reads positive here. */
export function signedNet(
  normalBalance: string,
  debit: Money,
  credit: Money,
): Money {
  return normalBalance === 'DEBIT'
    ? debit.subtract(credit)
    : credit.subtract(debit);
}

/** Amount on the account TYPE's natural side (asset/expense → debit−credit;
 *  liability/equity/revenue → credit−debit). The financial-statement convention: a contra
 *  account nets AGAINST its parent type (accumulated depreciation reduces assets), so it
 *  reads negative here. Differs from signedNet only for contra accounts. */
export function naturalSide(type: string, debit: Money, credit: Money): Money {
  const debitNatured = type === 'ASSET' || type === 'EXPENSE';
  return debitNatured ? debit.subtract(credit) : credit.subtract(debit);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/ledger/balances/signing.spec.ts`
Expected: PASS — 9 passed.

- [ ] **Step 5: Lint the new files**

Run: `npx eslint src/ledger/balances/signing.ts src/ledger/balances/signing.spec.ts --max-warnings 0`
Expected: no output (clean).

- [ ] **Step 6: Commit**

```bash
git add src/ledger/balances/signing.ts src/ledger/balances/signing.spec.ts
git commit -m "feat(reporting): pure signing module (signedNet + naturalSide)

Two named account-signing conventions extracted to one tested home:
signedNet (by normalBalance) and naturalSide (by type, contra-aware).
A unit test pins their divergence for a contra account. Not yet wired.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Route the five duplicate fragments through the module

**Files:**
- Modify: `src/ledger/balances/balances.service.ts` (`toRow`, `trialBalance`, `accountBalance`)
- Modify: `src/reporting/general-ledger.service.ts`
- Modify: `src/reporting/balance-sheet.service.ts`
- Modify: `src/reporting/income-statement.service.ts`
- Regression net (unmodified): `test/reporting-statements.e2e-spec.ts`, `test/reporting-cashflow.e2e-spec.ts`, `test/reporting-ledger.e2e-spec.ts`, `test/balances.e2e-spec.ts`, `test/cash-flow-role.e2e-spec.ts`

**Interfaces:**
- Consumes from Task 1: `signedNet(normalBalance: string, debit: Money, credit: Money): Money`, `naturalSide(type: string, debit: Money, credit: Money): Money`.

- [ ] **Step 1: Establish the regression baseline (report e2e green BEFORE the change)**

Run: `npx jest --config ./test/jest-e2e.json reporting-statements reporting-cashflow reporting-ledger balances cash-flow-role`
Expected: PASS — neraca `balanced`, income statement, cash-flow `reconciles`, GL running balance, trial balance, balances all green. (Docker must be up.)

- [ ] **Step 2: Route `signedNet` in `balances.service.ts`**

Add the import after the existing `Money` import line (`import { Money } from '../../common/money/money';`):

```ts
import { signedNet } from './signing';
```

Replace the `toRow` method (currently builds a `Prisma.Decimal` `net` then `Money.of(net.toString())`):

```ts
  private toRow(r: RawBalanceRow): AccountBalanceRow {
    const net = signedNet(
      r.normal_balance,
      Money.of(r.debit.toString()),
      Money.of(r.credit.toString()),
    );
    return {
      accountId: r.account_id,
      code: r.code,
      name: r.name,
      type: r.type,
      subtype: r.subtype,
      normalBalance: r.normal_balance,
      cashFlowCategory: r.cash_flow_category,
      role: r.role,
      debit: Money.of(r.debit.toString()).toPersistence(),
      credit: Money.of(r.credit.toString()).toPersistence(),
      balance: net.toPersistence(),
    };
  }
```

In `trialBalance`, replace the per-row `net` block (leave the `totalDebit`/`totalCredit` accumulation above it untouched):

```ts
      const net = signedNet(
        r.normal_balance,
        Money.of(r.debit.toString()),
        Money.of(r.credit.toString()),
      );
      out.push({
        accountId: r.account_id,
        code: r.code,
        name: r.name,
        debit: Money.of(r.debit.toString()).toPersistence(),
        credit: Money.of(r.credit.toString()).toPersistence(),
        balance: net.toPersistence(),
      });
```

In `accountBalance`, replace the `net` computation and `balance` field:

```ts
    const debit = rows[0].debit;
    const credit = rows[0].credit;
    const net = signedNet(
      account.normalBalance,
      Money.of(debit.toString()),
      Money.of(credit.toString()),
    );
    return {
      accountId,
      debit: Money.of(debit.toString()).toPersistence(),
      credit: Money.of(credit.toString()).toPersistence(),
      balance: net.toPersistence(),
    };
```

- [ ] **Step 3: Route `signedNet` in `general-ledger.service.ts`**

Add the import after the existing `BalancesService` import:

```ts
import { signedNet } from '../ledger/balances/signing';
```

Delete the line `const debitNormal = account.normalBalance === 'DEBIT';`. Replace the `delta` computation inside `rows.map(...)`:

```ts
      const delta = signedNet(
        account.normalBalance,
        Money.of(r.debit.toString()),
        Money.of(r.credit.toString()),
      );
```

(`account.normalBalance` is already in scope from `this.accounts.findById`. The opening balance still comes from `this.balances.accountBalance(...).balance`, which now also flows through `signedNet` — consistent.)

- [ ] **Step 4: Route `naturalSide` in `balance-sheet.service.ts`**

Add the import after the existing `BalancesService` import block:

```ts
import { naturalSide } from '../ledger/balances/signing';
```

Delete the private `bsAmount` method (the `/** ASSET → debit−credit; … */` JSDoc through its closing `}`). In `group`, replace `const amt = this.bsAmount(r);` with:

```ts
      const amt = naturalSide(r.type, Money.of(r.debit), Money.of(r.credit));
```

(`Money` is already imported. Leave `cumulativeEarnings`/`currentYearEarnings` untouched.)

- [ ] **Step 5: Route `naturalSide` in `income-statement.service.ts`**

Add the import after the existing `BalancesService` import block:

```ts
import { naturalSide } from '../ledger/balances/signing';
```

Delete the private `mag` method (the `/** credit−debit for revenue/income; … */` JSDoc through its closing `}`). In `section`, replace `const amt = this.mag(r);` with:

```ts
      const amt = naturalSide(r.type, Money.of(r.debit), Money.of(r.credit));
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS (exit 0). Confirms all five call sites compile against the Task 1 signatures and no dangling references to the deleted `bsAmount`/`mag`/`debitNormal` remain.

- [ ] **Step 7: Lint**

Run: `npm run lint:ci`
Expected: clean (exit 0).

- [ ] **Step 8: Run the report e2e (behaviour preserved)**

Run: `npx jest --config ./test/jest-e2e.json reporting-statements reporting-cashflow reporting-ledger balances cash-flow-role`
Expected: PASS — identical to the Step 1 baseline. Neraca still `balanced`, cash-flow still `reconciles`, income statement / GL / trial-balance figures unchanged, including the contra (Akumulasi Penyusutan) flowing through `naturalSide` on the balance sheet.

- [ ] **Step 9: Full verification gate**

Run: `npm run verify`
Expected: PASS — `typecheck` (exit 0), `lint:ci` (clean), `test` (all unit incl. `signing.spec.ts`), `test:e2e:cov` (all e2e pass **and** global coverage ≥ 84/62/84/84).

- [ ] **Step 10: Commit**

```bash
git add src/ledger/balances/balances.service.ts src/reporting/general-ledger.service.ts src/reporting/balance-sheet.service.ts src/reporting/income-statement.service.ts
git commit -m "refactor(reporting): route signing through the shared signing module

balances.service (toRow/trialBalance/accountBalance) and general-ledger
now sign via signedNet; balance-sheet and income-statement via
naturalSide. bsAmount/mag deleted. Behavior unchanged; report e2e green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 11: Final sanity diff**

Run: `git diff --stat main`
Expected: `signing.ts` + `signing.spec.ts` (new), `balances.service.ts`, `general-ledger.service.ts`, `balance-sheet.service.ts`, `income-statement.service.ts` (modified, net reduction in the three report services as inline ternaries/methods collapse to a call), plus the design spec. No `cash-flow.service.ts`, no DTOs, no controllers, no schema.

---

## Self-Review

**1. Spec coverage**
- §4 module shape (`signedNet` + `naturalSide`, Money-based, string params) → Task 1 Step 3. ✓
- §5 call-site routing (balances ×3, general-ledger, balance-sheet, income-statement) → Task 2 Steps 2–5. ✓
- §3/§5 out-of-scope (cash-flow, earnings sub-figures, DTOs, schema) → Global Constraints + Steps 4–5 notes + Step 11 diff. ✓
- §8 testing (new unit spec incl. contra divergence; existing report e2e as net) → Task 1 Steps 1–4; Task 2 Steps 1, 8, 9. ✓
- §9 verification + migration (two commits, `npm run verify`, sanity diff) → Task 1 Step 6, Task 2 Steps 9–11. ✓
- §10 risk (Decimal→Money equivalence; contra trap pinned by test) → Global Constraints + Task 1 contra test. ✓
- §1 equivalence (naturalSide ≡ bsAmount/mag; signedNet ≡ the 4 normalBalance copies) → Task 1 test cases assert each branch; Task 2 routing replaces each copy verbatim-equivalently. ✓

**2. Placeholder scan:** No "TBD"/"add validation"/"similar to". Every code step shows complete before/after; every run step gives the exact command + expected result. ✓

**3. Type consistency:** `signedNet(normalBalance: string, debit: Money, credit: Money): Money` and `naturalSide(type: string, debit: Money, credit: Money): Money` are identical between Task 1's Produces block, Task 1 Step 3's definitions, the Step 1 test calls, and every Task 2 call site. `Money.of(...).toPersistence()` is the unchanged 4dp serialization at every site. `account.normalBalance` (enum, assignable to `string`) and `r.normal_balance`/`r.type` (`string`) all satisfy the `string` params. ✓

No issues found.
