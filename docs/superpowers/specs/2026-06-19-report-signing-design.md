# One home for normal-balance signing

**Date:** 2026-06-19
**Status:** Approved (design) — ready for implementation plan
**Origin:** Architecture review candidate #3 ("One home for normal-balance signing").
Independent of candidates #1/#2.

## Vocabulary

Architecture terms are used exactly (per `improve-codebase-architecture`):
**module, interface, implementation, depth, deep/shallow, seam, adapter, leverage, locality.**
Domain terms per `docs/runbooks/domain-glossary.md`. Two conventions named here:
**signed-net** (by `normalBalance`) and **natural-side** (by account `type`, contra-aware).

---

## 1. Problem

The rule "turn an account's debit/credit pair into a signed amount" is reimplemented across the
reporting and balances layers, reachable only through e2e, so a signing bug surfaces as a balance
mismatch with no locality. The review framed this as a single invariant copied five times, but the
copies are **not all the same rule** — and one of them ("every report signs through `BalancesService.toRow`")
would be an active bug if merged naively, because the chart has a **contra account**:
`chart-of-accounts.seed.ts:109` "Akumulasi Penyusutan" (Accumulated Depreciation) is
`type: 'ASSET'` with `normalBalance: 'CREDIT'`.

There are two distinct, both-correct conventions (they coincide only for non-contra accounts):

| Convention | Formula | Keyed on | Current copies |
| --- | --- | --- | --- |
| **signed-net** — account's own balance, positive on its normal side | `DEBIT ? d−c : c−d` | `normalBalance` | `balances.service.toRow`, `.trialBalance`, `.accountBalance`; `general-ledger` per-line delta |
| **natural-side** — amount on the type's natural side, contra nets against parent | `ASSET\|EXPENSE ? d−c : c−d` | `type` | `balance-sheet.bsAmount`, `income-statement.mag` |

For Akumulasi Penyusutan these **diverge**: natural-side gives `d−c` (negative → correctly reduces
assets on the balance sheet); signed-net gives `c−d` (positive → would wrongly *add* depreciation to
assets). A third convention — cash-flow's `cashEffect` = `c−d` always — is a movement-direction rule,
not normal-balance signing, and is **out of scope**.

## 2. Goal

Give each signing convention **one tested home** as a pure function, and route the duplicates through
it — **without merging** the two conventions (that would break contras). The review's real win:
signing becomes unit-testable in isolation instead of only via report e2e.

**Locality:** each convention lives once; a new account type signs consistently everywhere.
**Leverage:** one interface, five call sites; the divergence is documented and pinned by a test.

## 3. Scope

**In scope**
- New pure module `src/ledger/balances/signing.ts` exporting `signedNet` and `naturalSide`.
- Unit tests `src/ledger/balances/signing.spec.ts` (incl. the contra divergence).
- Route `signed-net` copies (balances.service ×3 + general-ledger) and `natural-side` copies
  (balance-sheet + income-statement) through the module.

**Out of scope (explicitly)**
- `cash-flow.service.ts` — `cashEffect` (`c−d`) and `cashBalance` (`d−c` for CASH) stay as documented
  one-liners (a different, cash-inflow convention).
- `balance-sheet`'s `cumulativeEarnings`/`currentYearEarnings` — the synthetic-earnings *algorithm*,
  not per-account signing; left intact.
- No DTO/response/route/HTTP changes. No schema changes. Behavior preserved exactly.

## 4. Module shape

`src/ledger/balances/signing.ts` — pure free functions over the `Money` value object (mirrors the
existing `src/ledger/posting/assert-balanced.ts` pure-helper precedent):

```ts
import { Money } from '../../common/money/money';

/** Net signed so the account's NORMAL side is positive (debit-normal → debit−credit;
 *  credit-normal → credit−debit). The trial-balance / general-ledger convention: every
 *  account's own balance as a positive-on-its-normal-side magnitude. A contra account
 *  (normalBalance opposite its type) reads positive here. */
export function signedNet(normalBalance: string, debit: Money, credit: Money): Money {
  return normalBalance === 'DEBIT' ? debit.subtract(credit) : credit.subtract(debit);
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

`string` params match the `AccountBalanceRow.normalBalance`/`type` fields (typed `string`) and the
`account.normalBalance` enum (assignable to `string`) — no caller churn, no casts.

**Equivalence (verified against current code):**
- `naturalSide('ASSET')`=`d−c`, `('LIABILITY')`/`('EQUITY')`=`c−d` → reproduces `bsAmount`
  (`type==='ASSET' ? d−c : c−d`) across the only types it sees.
- `naturalSide('REVENUE')`=`c−d`, `('EXPENSE')`=`d−c` → reproduces `mag`
  (`type==='REVENUE' ? c−d : d−c`).
- `signedNet('DEBIT')`=`d−c`, `('CREDIT')`=`c−d` → reproduces toRow/trialBalance/accountBalance and
  the general-ledger `debitNormal` delta.

## 5. Call-site routing (behavior-preserving)

**signed-net:**
- `balances.service.ts` `toRow` (≈85-88), `trialBalance` per-row net (≈131-134), `accountBalance`
  (≈172-173): replace the inline `r.normal_balance === 'DEBIT' ? r.debit.sub(r.credit) : …` with
  `signedNet(r.normal_balance, Money.of(r.debit.toString()), Money.of(r.credit.toString()))`, then
  `.toPersistence()` as today. (Currently builds a `Prisma.Decimal` net then `Money.of(net.toString())`;
  switching to `Money` is precision-equivalent — `Money` wraps decimal.js at the same 4dp.)
- `general-ledger.service.ts` (≈31, 45-47): replace the `debitNormal`/`delta` block with
  `signedNet(account.normalBalance, Money.of(r.debit.toString()), Money.of(r.credit.toString()))`;
  drop the now-unused `debitNormal` local.

**natural-side:**
- `balance-sheet.service.ts`: delete private `bsAmount` (≈24-29); at its call site (≈38) use
  `naturalSide(r.type, Money.of(r.debit), Money.of(r.credit))`.
- `income-statement.service.ts`: delete private `mag` (≈13-18); at its call site (≈27) use
  `naturalSide(r.type, Money.of(r.debit), Money.of(r.credit))`.

**Untouched:** `cash-flow.service.ts`; `balance-sheet` earnings sub-figures; all DTOs, controllers,
routes; `balances.service` raw SQL and the separate `totalDebit`/`totalCredit` sums in `trialBalance`.

## 6. Data flow

Unchanged. Reports still call `BalancesService.balancesAsOf`/`movementsBetween` to get
`AccountBalanceRow[]`, then sign per-row — now via the shared functions instead of inline copies. The
only difference is the signing fragment's owner.

## 7. Error handling

None introduced. The functions are total over the inputs they receive (the report filters guarantee
the type/normalBalance domains). No new throws, no new branches beyond the existing ternaries.

## 8. Testing

- **New `signing.spec.ts`** (the headline win — unit-testable signing):
  - `signedNet`: DEBIT-normal (`d−c`) and CREDIT-normal (`c−d`) cases.
  - `naturalSide`: ASSET, LIABILITY, EQUITY, REVENUE, EXPENSE.
  - **Contra divergence:** an ASSET input with `credit > debit` (Akumulasi Penyusutan) →
    `naturalSide` negative **and** `signedNet` positive for the same inputs, asserting the two rules
    differ exactly where the design says they do.
  - Money in/out at 4dp via `toPersistence()`.
- **Existing report e2e** are the integration net and must stay green (behavior preserved): neraca
  `balanced`, income statement totals, cash-flow `reconciles`, cross-report tie-outs, GL running
  balance, trial balance.
- Pure functions; no mocks needed for the unit tests.

## 9. Verification & migration

- Branch `feat/report-signing` off `main`. Likely two commits: (1) `signing.ts` + `signing.spec.ts`;
  (2) route the five call sites.
- Gate: `npm run verify` — `typecheck` (exit 0), `lint:ci` (clean), `test` (unit incl. new spec),
  `test:e2e:cov` (all e2e pass **and** global coverage ≥ 84/62/84/84). The new unit test nudges
  branch coverage up.
- Sanity diff vs `main`: `signing.ts`, `signing.spec.ts` (new) + `balances.service.ts`,
  `general-ledger.service.ts`, `balance-sheet.service.ts`, `income-statement.service.ts` (modified) +
  this spec. No cash-flow, DTO, controller, or schema changes.

## 10. Risks

- **Behavior drift:** only computational change is Decimal→Money at the `signedNet` sites in
  `balances.service`; `Money` wraps decimal.js at the same precision and the same `toPersistence()`
  rounding, so outputs are identical. `naturalSide` is a verbatim move of `bsAmount`/`mag`. The e2e
  tie-outs (neraca balanced, cash reconciles, cross-report) catch any sign regression.
- **The contra trap:** explicitly avoided by keeping two functions; pinned by the divergence unit test.
  A future maintainer who tries to "simplify" to one function will fail that test.
- **Smallest-possible diff:** ~5 call sites + one small pure module; low blast radius.
