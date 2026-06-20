# Deepen Company from a settings bag to a settings interpreter

**Date:** 2026-06-20
**Status:** Approved (design) — ready for implementation plan
**Origin:** Architecture review candidate #5 ("Deepen Company from a settings bag to a settings interpreter").
Independent of candidates #1/#2/#3.

## Vocabulary

Architecture terms are used exactly (per `improve-codebase-architecture`):
**module, interface, implementation, depth, deep/shallow, seam, adapter, leverage, locality.**
Domain terms per `docs/runbooks/domain-glossary.md`.

---

## 1. Problem

`CompanyService.get()` returns the raw `CompanySettings` singleton, and six interpreting readers each
pull `fiscalYearStartMonth` / `segregationOfDutiesEnabled` and glue them to helpers themselves. The
settings *shape* is part of six interfaces; "the fiscal year of a date" is split three ways (Company
yields a raw start month, the `dates` helper is pure, each caller combines them). `CompanyService` is a
pass-through — delete it and the readers query the singleton directly; little is hidden.

Concretely, three distinct interpretations hide behind `fiscalYearStartMonth`, and one behind the flag:

| Reader | Reads today | The question it is asking |
| --- | --- | --- |
| posting `preparePosting` / `postDraft` / (one more prep site) | `fiscalYearStartMonth` (×3), `segregationOfDutiesEnabled` (×2) | "fiscal year of this date?" + "is this post a SoD violation?" |
| periods `onModuleInit` | `fiscalYearStartMonth` | "fiscal year of *now*?" |
| periods `generatePeriods` | `fiscalYearStartMonth` (structural) | "where does the fiscal year start?" (lays out 12 months) |
| balance-sheet | `fiscalYearStartMonth` (×2) | "fiscal year of asOf?" **and** "FY start *date*?" |
| year-end-close | `fiscalYearStartMonth` (×2) | "FY start **and** end *dates* for year N?" |

The FY start/end-date interpretation is itself duplicated: `year-end-close` has private
`fiscalYearStart`/`fiscalYearEnd`, and `balance-sheet` inlines `Date.UTC(fy, startMonth - 1, 1)`.

## 2. Goal

Deepen `CompanyService` so readers ask **questions** instead of reading fields. Move the interpretation
*into* the module (so deletion would cost something), and consolidate the duplicated fiscal-year date
math into the existing pure `fiscal-year.ts` helper that `CompanyService` delegates to.

**Locality:** fiscal-year math + the SoD policy live behind one interface; a caching or settings-schema
change gets one home. **Leverage:** one interface, six readers; the settings shape stops crossing the seam.

## 3. Scope

**In scope**
- Add three intention methods to `CompanyService`: `fiscalYearFor(date)`, `fiscalYearBounds(year)`,
  `isSegregationViolation(args)`.
- Extend `src/common/dates/fiscal-year.ts` with pure `fiscalYearStartDate` / `fiscalYearEndDate`
  (moved verbatim from year-end-close's private helpers).
- Migrate the interpreting readers (posting, periods, balance-sheet, year-end-close) onto the methods;
  delete the now-dead private helpers (`posting.fiscalYearFor`, `year-end-close.fiscalYearStart`/`End`).
- Unit tests for the pure date helpers and the `CompanyService` methods.

**Out of scope (explicitly)**
- `CompanyService.get()` and `update()` — unchanged; `get()` is still the legitimate source for the
  GET-company endpoint and `update()`. We only migrate the *interpreting* readers.
- Caching. **Decision: stateless** — each intention method calls `get()` (a trivial 1-row singleton
  SELECT). A couple of paths therefore do two reads instead of one (posting: SoD-check + fiscal-year);
  this is negligible and avoids cache-invalidation and multi-instance staleness. (The review noted
  caching as a *possible* future home, not a requirement.)
- Company controller, DTOs, the Prisma schema — untouched. No HTTP/contract change.

## 4. Interface

`CompanyService` gains three async, stateless methods (each reads the singleton, delegates to pure helpers):

```ts
/** The fiscal year a date falls into, per the configured start month. */
async fiscalYearFor(date: Date): Promise<number> {
  const { fiscalYearStartMonth } = await this.get();
  return fiscalYearForDate(date, fiscalYearStartMonth);
}

/** UTC [start, end] date bounds of a fiscal year. */
async fiscalYearBounds(fiscalYear: number): Promise<{ start: Date; end: Date }> {
  const { fiscalYearStartMonth } = await this.get();
  return {
    start: fiscalYearStartDate(fiscalYear, fiscalYearStartMonth),
    end: fiscalYearEndDate(fiscalYear, fiscalYearStartMonth),
  };
}

/** Whether a post violates segregation of duties (enabled + MANUAL + poster is the creator). */
async isSegregationViolation(args: {
  sourceType: string;
  createdBy: string;
  postedBy: string;
}): Promise<boolean> {
  const { segregationOfDutiesEnabled } = await this.get();
  return (
    segregationOfDutiesEnabled &&
    args.sourceType === 'MANUAL' &&
    args.postedBy === args.createdBy
  );
}
```

Pure helper extension in `src/common/dates/fiscal-year.ts` (verbatim from year-end-close's private
methods, so the date boundaries are byte-identical):

```ts
export function fiscalYearStartDate(fiscalYear: number, startMonth: number): Date {
  return new Date(Date.UTC(fiscalYear, startMonth - 1, 1));
}
export function fiscalYearEndDate(fiscalYear: number, startMonth: number): Date {
  const endYear = startMonth === 1 ? fiscalYear : fiscalYear + 1;
  const endMonth0 = startMonth === 1 ? 11 : startMonth - 2; // 0-based last month
  return new Date(Date.UTC(endYear, endMonth0 + 1, 0)); // day 0 of next month = last day
}
```

**SoD policy boundary (judgment call):** the *whole* predicate — the flag **and** the `MANUAL` +
poster-is-creator rule — lives in `CompanyService`, because that rule is the governance policy and it
collapses two duplicated copies in posting. The `SegregationOfDutiesError` throw (message + `{ createdBy }`
context) stays in posting; `CompanyService` only answers the boolean question.

## 5. Reader migration (behavior-preserving)

- **`posting.service.ts`** (3 sites): replace each `await this.company.get()` + `this.fiscalYearFor(date,
  settings.fiscalYearStartMonth)` with `await this.company.fiscalYearFor(date)`; replace the two SoD
  blocks with `if (await this.company.isSegregationViolation({ sourceType, createdBy, postedBy })) throw
  new SegregationOfDutiesError(...)` (same message + context). **Delete** the private `fiscalYearFor`
  helper and the `fiscalYearForDate` import. preparePosting & postDraft now make two singleton reads
  (accepted).
- **`periods.service.ts`**: `onModuleInit` → `await this.company.fiscalYearFor(now)`. `generatePeriods`
  → seed the 12-month layout from `(await this.company.fiscalYearBounds(fiscalYear)).start`, deriving
  `startMonth = start.getUTCMonth() + 1`; the layout algorithm is otherwise unchanged. Drop the
  `fiscalYearForDate` import.
- **`balance-sheet.service.ts`**: `const fy = await this.company.fiscalYearFor(asOf)`; `const { start:
  fyStart } = await this.company.fiscalYearBounds(fy)`. Drop the `fiscalYearForDate` import and the
  inline `Date.UTC(...)`.
- **`year-end-close.service.ts`**: `const { start: fyStart, end: yearEnd } = await
  this.company.fiscalYearBounds(fiscalYear)`. **Delete** the private `fiscalYearStart`/`fiscalYearEnd`.

After migration, `fiscalYearStartMonth`/`segregationOfDutiesEnabled` are read only inside
`CompanyService`.

## 6. Data flow

Unchanged. The same dates and the same fiscal-year numbers/bounds are computed; only the *owner* of the
interpretation moves from each reader into `CompanyService` (+ the pure helper). No new queries beyond
the extra trivial singleton reads noted above.

## 7. Error handling

`isSegregationViolation` returns a boolean; posting keeps the `SegregationOfDutiesError` throw with its
exact message and context. `get()`'s existing `NotFoundDomainError('Company settings not initialized')`
still fires (the new methods call `get()`), so an uninitialized-settings call behaves as before. No new
error types.

## 8. Testing

- **`src/common/dates/fiscal-year.spec.ts`** (new) — pure date math:
  - `fiscalYearForDate` (already-used rule): a date before/after the start month.
  - `fiscalYearStartDate` / `fiscalYearEndDate`: January start (startMonth=1 → 2026-01-01 … 2026-12-31)
    and a non-January start (startMonth=4 → FY2026 = 2026-04-01 … 2027-03-31), covering the special case.
- **`src/company/company.service.spec.ts`** (new or extended) — mock `get()`:
  - `isSegregationViolation`: the security-relevant truth table (enabled/disabled × MANUAL/non-MANUAL ×
    poster=creator / poster≠creator).
  - `fiscalYearFor` / `fiscalYearBounds`: delegate to the pure helpers with the singleton's start month.
- **Existing e2e are the integration net** (must stay green): posting (SoD 403 + closed-year), periods
  boot, `reporting-statements` (FY earnings sub-figure), `close` (FY bounds). They exercise every new
  method after migration.

## 9. Verification & migration

- Branch `feat/company-interpreter` off `main`. Likely two commits: (1) pure helpers + `CompanyService`
  methods + their unit tests; (2) reader migration + delete the dead private helpers.
- Gate: `npm run verify` — `typecheck` (exit 0), `lint:ci` (clean), `test` (unit incl. new specs),
  `test:e2e:cov` (all e2e pass **and** global coverage ≥ 84/62/84/84).
- Sanity diff vs `main`: `fiscal-year.ts` (+spec), `company.service.ts` (+spec), `posting.service.ts`,
  `periods.service.ts`, `balance-sheet.service.ts`, `year-end-close.service.ts`, plus this spec. No
  company controller/DTO, no schema.

## 10. Risks

- **Behavior drift:** none expected. The FY date formulas and the SoD predicate are verbatim moves; the
  fiscal-year *number* rule is unchanged. The financial paths (posting closed-year guard, year-end-close
  bounds, neraca FY earnings) are covered by existing e2e tie-outs.
- **Extra singleton reads:** the stateless choice adds at most one trivial 1-row SELECT on the posting
  and balance-sheet paths — negligible, no hot loop.
- **SoD policy placement:** moving the full predicate into `CompanyService` is a deliberate boundary
  choice (governance policy belongs with the settings authority); the throw stays in posting.
- **Smallest-possible diff:** three new methods + two pure helpers + six call-site migrations and two
  private-helper deletions; low blast radius.
