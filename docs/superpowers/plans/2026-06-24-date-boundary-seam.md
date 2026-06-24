# A Date-Boundary Seam at the HTTP Edge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull the string→Date defaulting + `from ≤ to` invariant at the HTTP edge into one `common/dates` seam (`asOfOrToday`/`dateRange`/`optionalDateRange`), route the 5 default-to-today sites + reports' range + audit onto it, and consolidate the duplicate `AsOfQueryDto`.

**Architecture:** A new `src/common/dates/query-dates.ts` holds three pure functions; the `from ≤ to` guard lives once (`dateRange` delegates to `optionalDateRange`). Four controllers stop constructing `Date`s inline; the duplicate `AsOfQueryDto` becomes a re-export. Behavior-preserving except one deliberate change: audit `from > to` now 422.

**Tech Stack:** NestJS 11, class-validator DTOs, Jest (unit + e2e against testcontainers — Docker required for e2e).

**Spec:** `docs/superpowers/specs/2026-06-24-date-boundary-seam-design.md`

## Global Constraints

- **Behavior-preserving except one deliberate change.** The same `Date`s reach the services; only the owner of the string→Date conversion + `from ≤ to` invariant moves into one seam. THE ONE CHANGE: `audit.list` with `from > to` now returns **422** (`` `from` must be on or before `to` ``) instead of `[]` — narrow (both bounds present only).
- **Guard verbatim.** The `from ≤ to` throw is `ValidationFailedError('`from` must be on or before `to`', { from, to })` (raw-string context) — copied exactly from reports' current private `range()`.
- **Guard lives once** — `dateRange` delegates to `optionalDateRange`.
- **`parseDate` stays in `parse-date.ts`** (its journal/sales-invoices callers untouched). `optionalDateRange` reuses it.
- **Out of scope — do not touch:** the report/balance/aging/audit *services*, all response DTOs, `RangeQueryDto`/`LedgerQueryDto` (stay local), the schema. No other HTTP/contract change.
- **No `any`.** Lint `--max-warnings 0`. Coverage gate `test:e2e:cov` global 84/62/84/84.
- **Branch:** `feat/date-boundary-seam` (already created off `main` at `be389e0`).

---

## File Structure

**Create**
- `src/common/dates/query-dates.ts` — `asOfOrToday`, `optionalDateRange`, `dateRange`.
- `src/common/dates/query-dates.spec.ts` — unit tests.

**Modify**
- `src/reporting/reports.controller.ts` — delete private `range()`; route 6 endpoints.
- `src/ledger/balances/balances.controller.ts` — `asOfOrToday`.
- `src/ledger/accounts/accounts.controller.ts` — `asOfOrToday`.
- `src/audit/audit.controller.ts` — `optionalDateRange` (gains the guard).
- `src/reporting/dto/report-query.dto.ts` — delete local `AsOfQueryDto`, re-export from `common/dto`.

**Unchanged:** `parse-date.ts`, `common/dto/as-of-query.dto.ts`, all services + response DTOs, schema.

---

## Task 1: The `query-dates` module + unit tests

**Files:**
- Create: `src/common/dates/query-dates.ts`
- Test: `src/common/dates/query-dates.spec.ts`

**Interfaces (produced, consumed by Task 2):**
- `asOfOrToday(asOf?: string): Date`
- `optionalDateRange(from?: string, to?: string): { from?: Date; to?: Date }`
- `dateRange(from: string, to: string): { from: Date; to: Date }`

- [ ] **Step 1: Write the failing unit tests**

Create `src/common/dates/query-dates.spec.ts`:

```ts
import { ValidationFailedError } from '../errors/domain-errors';
import { asOfOrToday, dateRange, optionalDateRange } from './query-dates';

describe('asOfOrToday', () => {
  it('parses a provided as-of string', () => {
    expect(asOfOrToday('2026-03-15').toISOString()).toBe(
      '2026-03-15T00:00:00.000Z',
    );
  });
  it('defaults to a valid Date (today) when absent', () => {
    const d = asOfOrToday(undefined);
    expect(d).toBeInstanceOf(Date);
    expect(Number.isNaN(d.getTime())).toBe(false);
  });
});

describe('dateRange', () => {
  it('returns both dates when ordered', () => {
    const { from, to } = dateRange('2026-01-01', '2026-12-31');
    expect(from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-12-31T00:00:00.000Z');
  });
  it('throws ValidationFailedError when from > to', () => {
    expect(() => dateRange('2026-12-31', '2026-01-01')).toThrow(
      ValidationFailedError,
    );
    expect(() => dateRange('2026-12-31', '2026-01-01')).toThrow(
      '`from` must be on or before `to`',
    );
  });
});

describe('optionalDateRange', () => {
  it('returns undefineds when both absent', () => {
    expect(optionalDateRange(undefined, undefined)).toEqual({
      from: undefined,
      to: undefined,
    });
  });
  it('returns one bound without throwing when only one present', () => {
    expect(optionalDateRange('2026-01-01', undefined).from?.toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    expect(optionalDateRange(undefined, '2026-12-31').to?.toISOString()).toBe(
      '2026-12-31T00:00:00.000Z',
    );
  });
  it('throws when both present and from > to', () => {
    expect(() => optionalDateRange('2026-12-31', '2026-01-01')).toThrow(
      ValidationFailedError,
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/common/dates/query-dates.spec.ts`
Expected: FAIL — `Cannot find module './query-dates'`.

- [ ] **Step 3: Implement the module**

Create `src/common/dates/query-dates.ts`:

```ts
import { ValidationFailedError } from '../errors/domain-errors';
import { parseDate } from './parse-date';

/** A validated as-of query string → Date; missing means *today*. */
export function asOfOrToday(asOf?: string): Date {
  return asOf ? new Date(asOf) : new Date();
}

/** Optional [from, to] filter bounds. Converts each via parseDate; enforces from ≤ to
 *  ONLY when both are present. */
export function optionalDateRange(
  from?: string,
  to?: string,
): { from?: Date; to?: Date } {
  const f = parseDate(from);
  const t = parseDate(to);
  if (f && t && f.getTime() > t.getTime())
    throw new ValidationFailedError('`from` must be on or before `to`', {
      from,
      to,
    });
  return { from: f, to: t };
}

/** Required [from, to] range (report endpoints). Same from ≤ to invariant; both mandatory. */
export function dateRange(from: string, to: string): { from: Date; to: Date } {
  const { from: f, to: t } = optionalDateRange(from, to);
  return { from: f!, to: t! }; // both required strings → both defined
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/common/dates/query-dates.spec.ts`
Expected: PASS — 7 passed.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck`
Expected: PASS (exit 0). Self-contained; nothing imports it yet.

Run: `npx eslint src/common/dates/query-dates.ts src/common/dates/query-dates.spec.ts --max-warnings 0`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/common/dates/query-dates.ts src/common/dates/query-dates.spec.ts
git commit -m "feat(dates): HTTP query-date seam (asOfOrToday/dateRange/optionalDateRange)

The string->Date edge: default-to-today, required range, and optional range,
with the from<=to invariant in one place. Pure + unit-tested. Not yet wired.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Route the controllers; consolidate the DTO

**Files:**
- Modify: `src/reporting/reports.controller.ts`, `src/ledger/balances/balances.controller.ts`, `src/ledger/accounts/accounts.controller.ts`, `src/audit/audit.controller.ts`, `src/reporting/dto/report-query.dto.ts`
- Regression net (unmodified): `test/reporting-statements.e2e-spec.ts`, `test/reporting-ledger.e2e-spec.ts`, `test/reporting-aging.e2e-spec.ts`, `test/balances.e2e-spec.ts`, `test/accounts.e2e-spec.ts`, `test/audit.e2e-spec.ts`

**Interfaces:** Consumes `asOfOrToday` / `dateRange` / `optionalDateRange` from Task 1.

- [ ] **Step 1: Establish the regression baseline (green BEFORE the change)**

Run: `npx jest --config ./test/jest-e2e.json reporting-statements reporting-ledger reporting-aging balances accounts audit`
Expected: PASS — as-of reports, ranged reports (incl. `from > to` → 422), trial-balance, account balance, and audit list all green. (Docker must be up.)

Also confirm the one behavior change won't break an existing test:
Run: `grep -n "from.*to\|toISOString\|new Date" test/audit.e2e-spec.ts`
Expected: NO test sends `from > to` to `GET /audit` expecting `[]`. (If one does, its assertion must change to expect 422 in Step 4.)

- [ ] **Step 2: Route `reports.controller.ts`**

Replace the import:

```ts
import { ValidationFailedError } from '../common/errors/domain-errors';
```

with:

```ts
import { asOfOrToday, dateRange } from '../common/dates/query-dates';
```

Delete the private `range()` method:

```ts
  private range(q: { from: string; to: string }): { from: Date; to: Date } {
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (from.getTime() > to.getTime()) {
      throw new ValidationFailedError('`from` must be on or before `to`', {
        from: q.from,
        to: q.to,
      });
    }
    return { from, to };
  }
```

Then change the six endpoints:

```ts
  balanceSheet(@Query() q: AsOfQueryDto) {
    return this.balanceSheetSvc.generate(asOfOrToday(q.asOf));
  }

  incomeStatement(@Query() q: RangeQueryDto) {
    const { from, to } = dateRange(q.from, q.to);
    return this.incomeStatementSvc.generate(from, to);
  }

  generalLedger(@Query() q: LedgerQueryDto) {
    const { from, to } = dateRange(q.from, q.to);
    return this.generalLedgerSvc.generate(q.accountId, from, to);
  }

  arAging(@Query() q: AsOfQueryDto) {
    return this.agingSvc.aging('AR', asOfOrToday(q.asOf));
  }

  apAging(@Query() q: AsOfQueryDto) {
    return this.agingSvc.aging('AP', asOfOrToday(q.asOf));
  }

  cashFlowReport(@Query() q: RangeQueryDto) {
    const { from, to } = dateRange(q.from, q.to);
    return this.cashFlowSvc.generate(from, to);
  }
```

(Keep the `@ApiOkResponse`/`@Get` decorators above each method exactly as they are. The `AsOfQueryDto`/`RangeQueryDto`/`LedgerQueryDto` import from `'./dto/report-query.dto'` is unchanged.)

- [ ] **Step 3: Route `balances.controller.ts` and `accounts.controller.ts`**

In `balances.controller.ts`, add after the existing imports:

```ts
import { asOfOrToday } from '../../common/dates/query-dates';
```

and replace:

```ts
    const date = q.asOf ? new Date(q.asOf) : new Date();
    return this.balances.trialBalance(date);
```

with:

```ts
    return this.balances.trialBalance(asOfOrToday(q.asOf));
```

In `accounts.controller.ts`, add after the existing imports:

```ts
import { asOfOrToday } from '../../common/dates/query-dates';
```

and replace the `balance` body:

```ts
    return this.balances.accountBalance(
      id,
      q.asOf ? new Date(q.asOf) : new Date(),
    );
```

with:

```ts
    return this.balances.accountBalance(id, asOfOrToday(q.asOf));
```

- [ ] **Step 4: Route `audit.controller.ts` (closes the from ≤ to gap)**

Add after the existing imports:

```ts
import { optionalDateRange } from '../common/dates/query-dates';
```

and replace the `list` body:

```ts
  list(@Query() q: AuditQueryDto) {
    return this.audit.list({
      userId: q.userId,
      method: q.method,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    });
  }
```

with:

```ts
  list(@Query() q: AuditQueryDto) {
    const { from, to } = optionalDateRange(q.from, q.to);
    return this.audit.list({
      userId: q.userId,
      method: q.method,
      from,
      to,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    });
  }
```

(This is the one deliberate behavior change: `from > to` now 422.)

- [ ] **Step 5: Consolidate `AsOfQueryDto`**

In `src/reporting/dto/report-query.dto.ts`, delete the local `AsOfQueryDto` class and drop the now-unused `IsOptional` import. The file becomes:

```ts
import { IsDateString, IsUUID } from 'class-validator';

export { AsOfQueryDto } from '../../common/dto/as-of-query.dto';

export class RangeQueryDto {
  @IsDateString() from!: string;
  @IsDateString() to!: string;
}

export class LedgerQueryDto {
  @IsUUID() accountId!: string;
  @IsDateString() from!: string;
  @IsDateString() to!: string;
}
```

(`reports.controller`'s `import { AsOfQueryDto, RangeQueryDto, LedgerQueryDto } from './dto/report-query.dto'` is unchanged — `AsOfQueryDto` is now re-exported.)

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS (exit 0). Confirms no dangling `range`/`ValidationFailedError`/`IsOptional` references and that all four controllers consume the new helpers.

- [ ] **Step 7: Lint**

Run: `npm run lint:ci`
Expected: clean (catches the removed `ValidationFailedError`/`IsOptional` imports if any reference lingers).

- [ ] **Step 8: Run the affected e2e (behaviour preserved)**

Run: `npx jest --config ./test/jest-e2e.json reporting-statements reporting-ledger reporting-aging balances accounts audit`
Expected: PASS — identical to the Step 1 baseline (the report `from > to` → 422 still holds; as-of defaulting unchanged; audit list still works, now also 422 on `from > to`).

- [ ] **Step 9: Full verification gate**

Run: `npm run verify`
Expected: PASS — typecheck (exit 0), `lint:ci` (clean), `test` (unit incl. `query-dates.spec`), `test:e2e:cov` (all e2e pass **and** global coverage ≥ 84/62/84/84).

- [ ] **Step 10: Commit**

```bash
git add src/reporting/reports.controller.ts src/ledger/balances/balances.controller.ts src/ledger/accounts/accounts.controller.ts src/audit/audit.controller.ts src/reporting/dto/report-query.dto.ts
git commit -m "refactor: route controllers through the query-date seam; dedupe AsOfQueryDto

reports/balances/accounts use asOfOrToday; reports' range() and audit use
dateRange/optionalDateRange (audit now 422s on from>to, was []). The
duplicate AsOfQueryDto is consolidated to common/dto. Behavior otherwise
unchanged; e2e green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 11: Final sanity diff**

Run: `git diff --stat main`
Expected: `query-dates.ts` + `query-dates.spec.ts` (new); `reports.controller.ts`, `balances.controller.ts`, `accounts.controller.ts`, `audit.controller.ts`, `report-query.dto.ts` (modified), plus the design spec. No service/response-DTO/schema change; `parse-date.ts` + `common/dto/as-of-query.dto.ts` untouched.

---

## Self-Review

**1. Spec coverage**
- §4 module (`asOfOrToday`/`optionalDateRange`/`dateRange`, guard once) → Task 1 Step 3. ✓
- §5 consumer collapse (reports ×6, balances, accounts, audit, DTO re-export) → Task 2 Steps 2–5. ✓
- §3 one behavior change (audit `from > to` → 422) → Task 2 Step 4 + Step 1 grep check. ✓
- §3 scope: `parseDate` stays; services/response-DTOs/`RangeQueryDto`/`LedgerQueryDto`/schema untouched → Global Constraints + Step 11 diff. ✓
- §7 error handling (guard verbatim; `asOfOrToday` cannot throw) → Step 3 implementation. ✓
- §8 testing (pure unit + e2e net + audit grep) → Task 1 Steps 1–4; Task 2 Steps 1, 8, 9. ✓
- §9 verification (two commits, `npm run verify`, sanity diff) → Task 1 Step 6; Task 2 Steps 9–11. ✓

**2. Placeholder scan:** No "TBD"/"add validation"/"similar to". Complete before/after in every code step; exact commands + expected output in every run step. ✓

**3. Type consistency:** `asOfOrToday(asOf?: string): Date`, `dateRange(from, to): { from: Date; to: Date }`, `optionalDateRange(from?, to?): { from?: Date; to?: Date }` are identical between Task 1's Produces block, Step 3's definitions, the Step 1 tests, and the Task 2 call sites. `dateRange` destructuring `{ from, to }` (both Date) matches reports' usage; `optionalDateRange`'s `{ from?, to? }` matches audit passing them into `audit.list` (which already accepts `Date | undefined`). The re-exported `AsOfQueryDto` keeps `reports.controller`'s import valid. ✓

No issues found.
