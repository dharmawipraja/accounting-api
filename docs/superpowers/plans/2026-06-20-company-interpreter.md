# Deepen Company into a Settings Interpreter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `CompanyService` three intention-revealing methods (`fiscalYearFor`, `fiscalYearBounds`, `isSegregationViolation`) so six readers stop reading raw settings fields, and consolidate the duplicated fiscal-year date math into the pure `fiscal-year.ts` helper.

**Architecture:** Task 1 extends the pure `src/common/dates/fiscal-year.ts` with `fiscalYearStartDate`/`fiscalYearEndDate` (moved verbatim from year-end-close's private helpers) and adds three stateless async methods to `CompanyService` that read the singleton via the existing `get()` and delegate to the pure helpers. Task 2 migrates the four reader services onto those methods and deletes the now-dead private helpers. Behavior is preserved exactly.

**Tech Stack:** NestJS 11, Prisma 7, Jest (unit + e2e against testcontainers — Docker required for e2e).

**Spec:** `docs/superpowers/specs/2026-06-20-company-interpreter-design.md`

## Global Constraints

- **No behavior change.** The fiscal-year *number* rule, the FY start/end *date* formulas, and the SoD predicate are all verbatim. Outputs identical.
- **Stateless.** Each new method calls `this.get()` (a trivial 1-row singleton SELECT). No caching, no invalidation. A couple of paths now make two reads (posting: SoD-check + fiscal-year) — accepted.
- **SoD boundary.** The full predicate (`segregationOfDutiesEnabled && sourceType === 'MANUAL' && postedBy === createdBy`) lives in `CompanyService.isSegregationViolation`. The `SegregationOfDutiesError` throw (message `'The poster must differ from the entry creator'` + `{ createdBy }` context) stays in posting.
- **`get()` and `update()` are unchanged** and still serve the GET-company endpoint and `update()`. Only the *interpreting* readers migrate.
- **Out of scope — do not touch:** company controller, DTOs, the Prisma schema.
- **No `any`.** Use the established `x as unknown as T` double-assert only where the codebase already does (test mocks).
- **Lint gate:** `npm run lint:ci` (`--max-warnings 0`). **Coverage gate:** `npm run test:e2e:cov` global 84/62/84/84.
- **Branch:** `feat/company-interpreter` (already created off `main` at `8256da2`).

---

## File Structure

**Modify**
- `src/common/dates/fiscal-year.ts` — add `fiscalYearStartDate`, `fiscalYearEndDate`.
- `src/common/dates/fiscal-year.spec.ts` — extend with cases for the two new helpers.
- `src/company/company.service.ts` — add `fiscalYearFor`, `fiscalYearBounds`, `isSegregationViolation`.
- `src/ledger/posting/posting.service.ts` — migrate 3 sites, delete private `fiscalYearFor`.
- `src/ledger/periods/periods.service.ts` — migrate `onModuleInit` + `generatePeriods`.
- `src/reporting/balance-sheet.service.ts` — migrate `generate`.
- `src/close/year-end-close.service.ts` — migrate usage, delete private `fiscalYearStart`/`fiscalYearEnd`.

**Create**
- `src/company/company.service.spec.ts` — unit tests for the three methods.

**Unchanged (do not touch):** company controller, DTOs, schema, all e2e specs.

---

## Task 1: Pure date helpers + CompanyService intention methods

**Files:**
- Modify: `src/common/dates/fiscal-year.ts`
- Modify (test): `src/common/dates/fiscal-year.spec.ts`
- Modify: `src/company/company.service.ts`
- Create (test): `src/company/company.service.spec.ts`

**Interfaces:**
- Produces (consumed by Task 2):
  - `fiscalYearStartDate(fiscalYear: number, startMonth: number): Date`
  - `fiscalYearEndDate(fiscalYear: number, startMonth: number): Date`
  - `CompanyService.fiscalYearFor(date: Date): Promise<number>`
  - `CompanyService.fiscalYearBounds(fiscalYear: number): Promise<{ start: Date; end: Date }>`
  - `CompanyService.isSegregationViolation(args: { sourceType: string; createdBy: string; postedBy: string }): Promise<boolean>`

- [ ] **Step 1: Extend the pure-helper unit tests (failing)**

In `src/common/dates/fiscal-year.spec.ts`, replace the import line with:

```ts
import {
  fiscalYearForDate,
  fiscalYearStartDate,
  fiscalYearEndDate,
} from './fiscal-year';
```

And append these describe blocks after the existing `fiscalYearForDate` block:

```ts
describe('fiscalYearStartDate', () => {
  it('January start → Jan 1 of the fiscal year', () => {
    expect(fiscalYearStartDate(2026, 1).toISOString().slice(0, 10)).toBe(
      '2026-01-01',
    );
  });
  it('April start → Apr 1 of the fiscal year', () => {
    expect(fiscalYearStartDate(2026, 4).toISOString().slice(0, 10)).toBe(
      '2026-04-01',
    );
  });
});

describe('fiscalYearEndDate', () => {
  it('January start → Dec 31 of the same year', () => {
    expect(fiscalYearEndDate(2026, 1).toISOString().slice(0, 10)).toBe(
      '2026-12-31',
    );
  });
  it('April start → Mar 31 of the next year', () => {
    expect(fiscalYearEndDate(2026, 4).toISOString().slice(0, 10)).toBe(
      '2027-03-31',
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/common/dates/fiscal-year.spec.ts`
Expected: FAIL — `fiscalYearStartDate`/`fiscalYearEndDate` are not exported (TS/runtime error).

- [ ] **Step 3: Add the two pure helpers**

In `src/common/dates/fiscal-year.ts`, append after the existing `fiscalYearForDate`:

```ts
/** First UTC day of a fiscal year, given the configured start month (1-12). */
export function fiscalYearStartDate(fiscalYear: number, startMonth: number): Date {
  return new Date(Date.UTC(fiscalYear, startMonth - 1, 1));
}

/** Last UTC day of a fiscal year, given the configured start month (1-12). */
export function fiscalYearEndDate(fiscalYear: number, startMonth: number): Date {
  const endYear = startMonth === 1 ? fiscalYear : fiscalYear + 1;
  const endMonth0 = startMonth === 1 ? 11 : startMonth - 2; // 0-based last month
  return new Date(Date.UTC(endYear, endMonth0 + 1, 0)); // day 0 of next month = last day
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/common/dates/fiscal-year.spec.ts`
Expected: PASS — 7 passed (3 existing + 4 new).

- [ ] **Step 5: Write the CompanyService unit tests (failing)**

Create `src/company/company.service.spec.ts`:

```ts
import { CompanySettings } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { CompanyService } from './company.service';

function build(settings: Partial<CompanySettings>): CompanyService {
  const svc = new CompanyService(undefined as unknown as PrismaService);
  jest
    .spyOn(svc, 'get')
    .mockResolvedValue(settings as unknown as CompanySettings);
  return svc;
}

describe('CompanyService.fiscalYearFor', () => {
  it('uses the configured start month', async () => {
    const svc = build({ fiscalYearStartMonth: 4 });
    expect(await svc.fiscalYearFor(new Date('2026-03-31T00:00:00Z'))).toBe(2025);
    expect(await svc.fiscalYearFor(new Date('2026-04-01T00:00:00Z'))).toBe(2026);
  });
});

describe('CompanyService.fiscalYearBounds', () => {
  it('returns April-start FY bounds', async () => {
    const svc = build({ fiscalYearStartMonth: 4 });
    const { start, end } = await svc.fiscalYearBounds(2026);
    expect(start.toISOString().slice(0, 10)).toBe('2026-04-01');
    expect(end.toISOString().slice(0, 10)).toBe('2027-03-31');
  });
  it('returns January-start FY bounds', async () => {
    const svc = build({ fiscalYearStartMonth: 1 });
    const { start, end } = await svc.fiscalYearBounds(2026);
    expect(start.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(end.toISOString().slice(0, 10)).toBe('2026-12-31');
  });
});

describe('CompanyService.isSegregationViolation', () => {
  const A = { sourceType: 'MANUAL', createdBy: 'u1', postedBy: 'u1' };
  it('true when enabled, MANUAL, and poster is the creator', async () => {
    const svc = build({ segregationOfDutiesEnabled: true });
    expect(await svc.isSegregationViolation(A)).toBe(true);
  });
  it('false when the poster differs from the creator', async () => {
    const svc = build({ segregationOfDutiesEnabled: true });
    expect(await svc.isSegregationViolation({ ...A, postedBy: 'u2' })).toBe(
      false,
    );
  });
  it('false for non-MANUAL source types', async () => {
    const svc = build({ segregationOfDutiesEnabled: true });
    expect(
      await svc.isSegregationViolation({ ...A, sourceType: 'SALES_INVOICE' }),
    ).toBe(false);
  });
  it('false when the flag is disabled', async () => {
    const svc = build({ segregationOfDutiesEnabled: false });
    expect(await svc.isSegregationViolation(A)).toBe(false);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx jest src/company/company.service.spec.ts`
Expected: FAIL — `fiscalYearFor`/`fiscalYearBounds`/`isSegregationViolation` do not exist on `CompanyService`.

- [ ] **Step 7: Add the three methods to CompanyService**

In `src/company/company.service.ts`, add this import after the existing imports:

```ts
import {
  fiscalYearForDate,
  fiscalYearStartDate,
  fiscalYearEndDate,
} from '../common/dates/fiscal-year';
```

And add these three methods to the class, immediately after the `get()` method:

```ts
  /** The fiscal year a date falls into, per the configured start month. */
  async fiscalYearFor(date: Date): Promise<number> {
    const { fiscalYearStartMonth } = await this.get();
    return fiscalYearForDate(date, fiscalYearStartMonth);
  }

  /** UTC [start, end] date bounds of a fiscal year. */
  async fiscalYearBounds(
    fiscalYear: number,
  ): Promise<{ start: Date; end: Date }> {
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

- [ ] **Step 8: Run to verify it passes**

Run: `npx jest src/company/company.service.spec.ts src/common/dates/fiscal-year.spec.ts`
Expected: PASS — 7 (CompanyService) + 7 (fiscal-year) passed.

- [ ] **Step 9: Typecheck and lint**

Run: `npm run typecheck`
Expected: PASS (exit 0).

Run: `npm run lint:ci`
Expected: clean (exit 0).

- [ ] **Step 10: Commit**

```bash
git add src/common/dates/fiscal-year.ts src/common/dates/fiscal-year.spec.ts src/company/company.service.ts src/company/company.service.spec.ts
git commit -m "feat(company): intention methods + pure FY date helpers

CompanyService gains fiscalYearFor / fiscalYearBounds /
isSegregationViolation (stateless, delegating to pure fiscal-year
helpers). fiscalYearStartDate/fiscalYearEndDate added to the dates
helper. Unit-tested; not yet wired to readers.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Migrate the readers onto the intention methods

**Files:**
- Modify: `src/ledger/posting/posting.service.ts`
- Modify: `src/ledger/periods/periods.service.ts`
- Modify: `src/reporting/balance-sheet.service.ts`
- Modify: `src/close/year-end-close.service.ts`
- Regression net (unmodified): `test/posting.e2e-spec.ts`, `test/journal.e2e-spec.ts`, `test/close.e2e-spec.ts`, `test/periods.e2e-spec.ts`, `test/reporting-statements.e2e-spec.ts`

**Interfaces:**
- Consumes from Task 1: `CompanyService.fiscalYearFor(date)`, `.fiscalYearBounds(year)`, `.isSegregationViolation(args)`.

- [ ] **Step 1: Establish the regression baseline (e2e green BEFORE the change)**

Run: `npx jest --config ./test/jest-e2e.json posting journal close periods reporting-statements`
Expected: PASS — SoD 403 paths, closed-year guard, year-end-close FY bounds, periods boot, neraca FY earnings all green. (Docker must be up.)

- [ ] **Step 2: Migrate `posting.service.ts`**

Delete the import `import { fiscalYearForDate } from '../../common/dates/fiscal-year';`.

In `preparePosting`, replace this block:

```ts
    const settings = await this.company.get();
    if (
      settings.segregationOfDutiesEnabled &&
      input.sourceType === 'MANUAL' &&
      postedBy === input.createdBy
    ) {
      throw new SegregationOfDutiesError(
        'The poster must differ from the entry creator',
        { createdBy: input.createdBy },
      );
    }
```

with:

```ts
    if (
      await this.company.isSegregationViolation({
        sourceType: input.sourceType,
        createdBy: input.createdBy,
        postedBy,
      })
    ) {
      throw new SegregationOfDutiesError(
        'The poster must differ from the entry creator',
        { createdBy: input.createdBy },
      );
    }
```

And replace (later in `preparePosting`):

```ts
    const fiscalYear = this.fiscalYearFor(
      input.date,
      settings.fiscalYearStartMonth,
    );
```

with:

```ts
    const fiscalYear = await this.company.fiscalYearFor(input.date);
```

In the reversal method, replace:

```ts
    const settings = await this.company.get();
    const fiscalYear = this.fiscalYearFor(
      reversalDate,
      settings.fiscalYearStartMonth,
    );
```

with:

```ts
    const fiscalYear = await this.company.fiscalYearFor(reversalDate);
```

In `postDraft`, replace this block:

```ts
    const settings = await this.company.get();
    if (
      settings.segregationOfDutiesEnabled &&
      draft.sourceType === 'MANUAL' &&
      postedBy === draft.createdBy
    ) {
      throw new SegregationOfDutiesError(
        'The poster must differ from the entry creator',
        {
          createdBy: draft.createdBy,
        },
      );
    }
```

with:

```ts
    if (
      await this.company.isSegregationViolation({
        sourceType: draft.sourceType,
        createdBy: draft.createdBy,
        postedBy,
      })
    ) {
      throw new SegregationOfDutiesError(
        'The poster must differ from the entry creator',
        {
          createdBy: draft.createdBy,
        },
      );
    }
```

And replace (later in `postDraft`):

```ts
    const fiscalYear = this.fiscalYearFor(
      draft.date,
      settings.fiscalYearStartMonth,
    );
```

with:

```ts
    const fiscalYear = await this.company.fiscalYearFor(draft.date);
```

Finally, delete the private helper:

```ts
  /** Fiscal year that a date falls into, given the configured start month. */
  fiscalYearFor(date: Date, startMonth: number): number {
    return fiscalYearForDate(date, startMonth);
  }
```

- [ ] **Step 3: Migrate `periods.service.ts`**

Delete the import `import { fiscalYearForDate } from '../../common/dates/fiscal-year';`.

Replace `onModuleInit`'s body:

```ts
    const settings = await this.company.get();
    const now = new Date();
    const fiscalYear = fiscalYearForDate(now, settings.fiscalYearStartMonth);
    await this.generatePeriods(fiscalYear);
```

with:

```ts
    const now = new Date();
    const fiscalYear = await this.company.fiscalYearFor(now);
    await this.generatePeriods(fiscalYear);
```

In `generatePeriods`, replace:

```ts
    const settings = await this.company.get();
    const startMonth = settings.fiscalYearStartMonth; // 1..12
```

with:

```ts
    const { start } = await this.company.fiscalYearBounds(fiscalYear);
    const startMonth = start.getUTCMonth() + 1; // 1..12
```

(`fiscalYearStartDate(fiscalYear, sm).getUTCMonth() + 1 === sm`, so `startMonth` is identical; the 12-month layout below is unchanged.)

- [ ] **Step 4: Migrate `balance-sheet.service.ts`**

Delete the import `import { fiscalYearForDate } from '../common/dates/fiscal-year';` (keep the `CompanyService` import — still used).

Replace:

```ts
    const settings = await this.company.get();
    const fy = fiscalYearForDate(asOf, settings.fiscalYearStartMonth);
    const fyStart = new Date(
      Date.UTC(fy, settings.fiscalYearStartMonth - 1, 1),
    );
```

with:

```ts
    const fy = await this.company.fiscalYearFor(asOf);
    const { start: fyStart } = await this.company.fiscalYearBounds(fy);
```

- [ ] **Step 5: Migrate `year-end-close.service.ts`**

Replace:

```ts
    const settings = await this.company.get();
    const yearEnd = this.fiscalYearEnd(
      fiscalYear,
      settings.fiscalYearStartMonth,
    );
    const fyStart = this.fiscalYearStart(
      fiscalYear,
      settings.fiscalYearStartMonth,
    );
```

with:

```ts
    const { start: fyStart, end: yearEnd } =
      await this.company.fiscalYearBounds(fiscalYear);
```

Delete the two private helpers:

```ts
  private fiscalYearStart(fiscalYear: number, startMonth: number): Date {
    return new Date(Date.UTC(fiscalYear, startMonth - 1, 1));
  }
  private fiscalYearEnd(fiscalYear: number, startMonth: number): Date {
    const endYear = startMonth === 1 ? fiscalYear : fiscalYear + 1;
    const endMonth0 = startMonth === 1 ? 11 : startMonth - 2; // 0-based last month
    return new Date(Date.UTC(endYear, endMonth0 + 1, 0)); // day 0 of next month = last day
  }
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS (exit 0). Confirms no dangling `settings`, no leftover references to the deleted `fiscalYearFor`/`fiscalYearStart`/`fiscalYearEnd` or removed imports.

- [ ] **Step 7: Lint**

Run: `npm run lint:ci`
Expected: clean (exit 0). (Catches any now-unused import or variable.)

- [ ] **Step 8: Run the migrated paths' e2e (behaviour preserved)**

Run: `npx jest --config ./test/jest-e2e.json posting journal close periods reporting-statements`
Expected: PASS — identical to the Step 1 baseline. SoD 403, closed-year guard, year-end-close bounds, periods boot, neraca FY earnings unchanged.

- [ ] **Step 9: Full verification gate**

Run: `npm run verify`
Expected: PASS — `typecheck` (exit 0), `lint:ci` (clean), `test` (unit incl. Task 1 specs), `test:e2e:cov` (all e2e pass **and** global coverage ≥ 84/62/84/84).

- [ ] **Step 10: Commit**

```bash
git add src/ledger/posting/posting.service.ts src/ledger/periods/periods.service.ts src/reporting/balance-sheet.service.ts src/close/year-end-close.service.ts
git commit -m "refactor: readers ask CompanyService instead of reading settings fields

posting/periods/balance-sheet/year-end-close now call fiscalYearFor /
fiscalYearBounds / isSegregationViolation; the duplicated FY date math and
the SoD predicate are gone from the readers. Dead private helpers deleted.
Behavior unchanged; posting/close/periods/reporting e2e green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 11: Final sanity diff**

Run: `git diff --stat main`
Expected: `fiscal-year.ts` (+spec), `company.service.ts` (+ new spec), `posting.service.ts`, `periods.service.ts`, `balance-sheet.service.ts`, `year-end-close.service.ts` (net reductions where private helpers/inline math were deleted), plus the design spec. No company controller/DTO, no schema.

---

## Self-Review

**1. Spec coverage**
- §4 interface (3 methods + 2 pure helpers) → Task 1 Steps 3, 7. ✓
- §5 reader migration (posting ×3, periods ×2, balance-sheet, year-end-close; delete dead helpers) → Task 2 Steps 2–5. ✓
- §3 scope: `get()`/`update()`/controller/DTO/schema untouched; stateless (no cache) → Global Constraints + Task 2 Step 11 diff. ✓
- §7 error handling: SoD throw stays in posting; `get()`'s NotFound still fires → Task 2 Step 2 keeps the throw; methods call `get()`. ✓
- §8 testing (pure helpers + CompanyService unit; existing e2e net) → Task 1 Steps 1–8; Task 2 Steps 1, 8, 9. ✓
- §9 verification (two commits, `npm run verify`, sanity diff) → Task 1 Step 10; Task 2 Steps 9–11. ✓
- §10 risk (verbatim formulas; extra singleton read) → Global Constraints. ✓

**2. Placeholder scan:** No "TBD"/"add validation"/"similar to". Every code step shows complete before/after; every run step gives the exact command + expected result. ✓

**3. Type consistency:** `fiscalYearFor(date: Date): Promise<number>`, `fiscalYearBounds(fiscalYear: number): Promise<{ start: Date; end: Date }>`, `isSegregationViolation(args: { sourceType: string; createdBy: string; postedBy: string }): Promise<boolean>`, `fiscalYearStartDate(fiscalYear, startMonth): Date`, `fiscalYearEndDate(fiscalYear, startMonth): Date` are identical between Task 1's Produces block, their definitions, the unit tests, and every Task 2 call site. `{ start, end }` destructuring matches the `{ start: Date; end: Date }` return at each consumer. `sourceType`/`createdBy`/`postedBy` keys match between the method signature and the posting call sites (`input.*` / `draft.*`). ✓

No issues found.
