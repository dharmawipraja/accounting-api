# A date-boundary seam at the HTTP edge

**Date:** 2026-06-24
**Status:** Approved (design) — ready for implementation plan
**Origin:** Architecture review round-2 candidate #4 ("A date-boundary seam at the HTTP edge").

## Vocabulary

Architecture terms per the `improve-codebase-architecture` skill: **module, interface, implementation,
depth, deep/shallow, seam, adapter, leverage, locality.** Domain terms per `docs/runbooks/domain-glossary.md`.

---

## 1. Problem

Converting a validated ISO date string at the HTTP boundary into the `Date` the services consume is an
interface concern — it carries a defaulting rule ("missing as-of = today"), an invariant (`from ≤ to`),
and an error mode (`ValidationFailedError`). Today that knowledge is smeared across the controllers as
**three different idioms**:

| Idiom | Sites | |
| --- | --- | --- |
| `parseDate(x)` → `Date \| undefined` | `journal.controller`, `sales-invoices.controller` | already shared ✓ |
| `x ? new Date(x) : new Date()` (default-to-today) | `reports.controller` ×3 (balanceSheet/ar-aging/ap-aging), `balances.controller`, `accounts.controller` | **5 inline copies** |
| `x ? new Date(x) : undefined` | `audit.controller` (`from`/`to`) | **= `parseDate`, inlined** |

The `from ≤ to` invariant lives only in `reports.controller`'s private `range()` (used by
income-statement / general-ledger / cash-flow). `audit.list` takes `from`/`to` and enforces **nothing** —
a `from > to` audit query silently returns `[]`. And `AsOfQueryDto` is declared **twice**, byte-identical:
`common/dto/as-of-query.dto.ts` (balances + accounts) and `reporting/dto/report-query.dto.ts` (reports).

## 2. Goal

Pull the string→Date+invariant edge into one small `common/dates` seam so callers ask for a domain `Date`
instead of constructing one, the `from ≤ to` invariant has one home, and the duplicate DTO is gone.

**Locality:** the defaulting rule + the range invariant live once. **Leverage:** `asOfOrToday` → 5
consumers; `dateRange`/`optionalDateRange` → 2 (reports + audit), so each is a real shared seam.

## 3. Scope

**In scope**
- New `src/common/dates/query-dates.ts`: `asOfOrToday(asOf?)`, `dateRange(from, to)`,
  `optionalDateRange(from?, to?)`.
- Route the 5 default-to-today sites onto `asOfOrToday`; reports' 3 range sites onto `dateRange`;
  `audit.list` onto `optionalDateRange` (closing the `from ≤ to` gap).
- Consolidate the duplicate `AsOfQueryDto` to `common/dto/as-of-query.dto.ts`.
- Unit tests for the three pure functions.

**One deliberate behavior change**
- `audit.list` with `from > to` now returns **422** (`` `from` must be on or before `to` ``) instead of
  `[]`. Narrow (fires only when both bounds are present), arguably-correct fail-fast.

**Out of scope (explicitly)**
- `parseDate` stays in `parse-date.ts` (its `journal`/`sales-invoices` callers unchanged); not moved.
- The report/balance/aging/audit **services**, all response DTOs, `RangeQueryDto`/`LedgerQueryDto`
  (stay local in `report-query.dto.ts`), and the schema are untouched. No other HTTP/contract change.

## 4. The module

`src/common/dates/query-dates.ts` — the `from ≤ to` guard lives in exactly one place:

```ts
import { ValidationFailedError } from '../errors/domain-errors';
import { parseDate } from './parse-date';

/** A validated as-of query string → Date; missing means *today*. */
export function asOfOrToday(asOf?: string): Date {
  return asOf ? new Date(asOf) : new Date();
}

/** Optional [from, to] filter bounds. Converts each via parseDate; enforces from ≤ to ONLY
 *  when both are present. */
export function optionalDateRange(
  from?: string,
  to?: string,
): { from?: Date; to?: Date } {
  const f = parseDate(from);
  const t = parseDate(to);
  if (f && t && f.getTime() > t.getTime())
    throw new ValidationFailedError('`from` must be on or before `to`', { from, to });
  return { from: f, to: t };
}

/** Required [from, to] range (report endpoints). Same from ≤ to invariant; both mandatory. */
export function dateRange(from: string, to: string): { from: Date; to: Date } {
  const { from: f, to: t } = optionalDateRange(from, to);
  return { from: f!, to: t! }; // both required strings → both defined
}
```

The guard's message (`` `from` must be on or before `to` ``) and `{ from, to }` raw-string context are
reproduced **verbatim** from reports' current private `range()`. `dateRange` delegates to
`optionalDateRange`, so the invariant is defined once.

## 5. Consumer collapse

- **`reports.controller.ts`** — delete the private `range()`; `balanceSheet`/`arAging`/`apAging` →
  `asOfOrToday(q.asOf)`; `incomeStatement`/`generalLedger`/`cashFlow` → `dateRange(q.from, q.to)`.
- **`balances.controller.ts`** → `asOfOrToday(q.asOf)`.
- **`accounts.controller.ts`** (`:id/balance`) → `asOfOrToday(q.asOf)`.
- **`audit.controller.ts`** → `const { from, to } = optionalDateRange(q.from, q.to)`; pass into
  `audit.list` (the from ≤ to guard now applies).
- **DTO** — delete the local `AsOfQueryDto` in `reporting/dto/report-query.dto.ts`; re-export it:
  `export { AsOfQueryDto } from '../../common/dto/as-of-query.dto';` (so `reports.controller`'s import is
  unchanged). `RangeQueryDto`/`LedgerQueryDto` stay.

## 6. Data flow

Unchanged except the audit guard. The same `Date`s reach the services; only the *owner* of the
string→Date conversion + the `from ≤ to` invariant moves from five controllers into one seam.

## 7. Error handling

`dateRange`/`optionalDateRange` throw the same `ValidationFailedError('`from` must be on or before `to`',
{ from, to })` reports threw before — now also for audit (both-present). `asOfOrToday` cannot throw
(class-validator already rejected a malformed `asOf` upstream via `@IsDateString`). No new error types.

## 8. Testing

- **New `src/common/dates/query-dates.spec.ts`** (pure):
  - `asOfOrToday('2026-03-15')` → that UTC date; `asOfOrToday(undefined)` → a `Date` (not `NaN`).
  - `dateRange`: ordered → both Dates; `from > to` → throws `ValidationFailedError` with the exact
    message + `{ from, to }` context.
  - `optionalDateRange`: both absent → `{}`; only one present → that one (no throw); both ordered → both;
    `from > to` → throws.
- **Existing e2e are the integration net** (as-of/range paths behavior-identical): `reporting-statements`
  (income-statement/cash-flow `from > to` → 422), `reporting-ledger`, `reporting-aging`, `balances`,
  `accounts` (`:id/balance` as-of), `audit`. The implementer confirms `audit.e2e-spec.ts` has no test
  asserting `from > to` returns `[]` (the one behavior change); if it does, that assertion becomes `422`.

## 9. Verification & migration

- Branch `feat/date-boundary-seam` off `main`. Two commits: (1) `query-dates.ts` + `query-dates.spec.ts`;
  (2) route the 4 controllers + consolidate the DTO.
- Gate: `npm run verify` — typecheck (exit 0), `lint:ci` (clean), `test` (unit incl. the new spec),
  `test:e2e:cov` (all e2e pass **and** global coverage ≥ 84/62/84/84).
- Sanity diff vs `main`: `query-dates.ts` + `query-dates.spec.ts` (new); `reports.controller.ts`,
  `balances.controller.ts`, `accounts.controller.ts`, `audit.controller.ts`, `report-query.dto.ts`
  (modified), plus this spec. No service/response-DTO/schema change; `parse-date.ts` untouched.

## 10. Risks

- **Lowest-risk of the round-2 Strong set** — pure date helpers at the HTTP edge; no SQL, money, or locks.
- **The one behavior change** (audit `from > to` → 422) is deliberate and narrow (both bounds present
  only); covered by the `optionalDateRange` unit test. Pre-merge check: no existing audit e2e relies on
  the old `[]`-return for `from > to`.
- **Smallest-possible diff:** one module + three pure functions + 5 call-site collapses + a deleted
  duplicate DTO class.
