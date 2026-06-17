# Architecture & Dead-Code Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the duplicated list/serialization/lifecycle/posting/date logic across the transactional modules into a small set of tested seams, remove verified-dead code, and unify the list contract — without changing financial behavior.

**Architecture:** Build each shared seam (with its own unit test) first, then migrate consumers one module at a time, keeping the full test suite green after every commit. The existing **80 unit + 198 e2e** tests are the behavioral spec for all behavior-preserving work. One deliberate breaking change: `accounts` and `tax-codes` lists move from bare array to the `{data,total,limit,offset}` envelope so every collection endpoint shares one shape.

**Tech Stack:** NestJS 11, Prisma 7 (`@prisma/client` + `@prisma/adapter-pg`), TypeScript (strict), Jest + ts-jest (unit), Jest + Testcontainers (`postgres:16`) for e2e, class-validator/class-transformer, `@nestjs/swagger`.

## Global Constraints

- **Behavior-preserving except one break.** Only `GET /v1/accounts` and `GET /v1/tax-codes` change shape (bare array → envelope). Everything else keeps identical runtime responses.
- **Full suite green per commit.** Run `npm test` (unit) and the relevant `npm run test:e2e -- <name>` after each task; run the full gate `npm run verify` before declaring a phase done.
- **`/v1` versioning is mandatory** in every e2e `beforeAll`: `app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })`. Omitting it 404s every request.
- **Run `npm run db:generate` (prisma generate) before any `npm run typecheck`** — a stale generated client surfaces phantom type errors.
- **Out of scope (own specs):** candidate C (TOCTOU `FOR SHARE`), candidate D (account role flags). Do not touch the deep core modules (`PostingService` posting math, `Money` internals, soft-delete extension semantics, `trigram-search` ranking SQL, `BalancesService` math) beyond the edits named here.
- **Money:** `Money.of(string|Decimal)` → `.toPersistence()` returns a fixed-4dp string (`this.value.toFixed(4)`); `Money.of` also runs a finite/HALF_UP check. All money in responses is a 4dp string.
- **Commands:** unit `npm test` / single `npx jest <path>`; e2e `npm run test:e2e -- <regex>`; typecheck `npm run typecheck`; lint `npm run lint:ci`; OpenAPI `npm run openapi:export`; full gate `npm run verify`.
- **MIN_QUERY_LENGTH = 2**, **SIMILARITY_THRESHOLD = 0.3** (both in `src/common/search/trigram-search.ts`). A search runs only when the trimmed `q` length ≥ 2.

---

## Phase 0 — Branch

### Task 0: Create the working branch

- [ ] **Step 1: Branch from main**

```bash
git checkout main && git checkout -b refactor/architecture-cleanup
```

- [ ] **Step 2: Confirm a clean baseline**

Run: `npm run db:generate && npm run typecheck`
Expected: exits 0, no errors.

---

## Phase 1 — Build the shared seams (TDD)

### Task 1: Pagination constants + `listPaginated` seam

**Files:**
- Create: `src/common/pagination/pagination.constants.ts`
- Create: `src/common/pagination/paginated.ts`
- Test: `src/common/pagination/paginated.spec.ts`

**Interfaces:**
- Produces: `DEFAULT_PAGE_SIZE = 50`, `MAX_LIMIT = 200`; `interface Paginated<T> { data: T[]; total: number; limit: number; offset: number }`; `listPaginated<TRow extends { id: string }, TOut>(params): Promise<Paginated<TOut>>` where `params = { q?, limit?, offset?, present, search, hydrate, page }` (signatures below).

- [ ] **Step 1: Write the failing test**

```ts
// src/common/pagination/paginated.spec.ts
import { listPaginated } from './paginated';

const present = (r: { id: string; n: number }) => ({ id: r.id, doubled: r.n * 2 });

describe('listPaginated', () => {
  it('uses the page branch when q is absent and applies the default page size', async () => {
    const page = jest.fn().mockResolvedValue({ rows: [{ id: 'a', n: 1 }], total: 1 });
    const search = jest.fn();
    const res = await listPaginated({ present, page, search, hydrate: jest.fn() });
    expect(res).toEqual({ data: [{ id: 'a', doubled: 2 }], total: 1, limit: 50, offset: 0 });
    expect(page).toHaveBeenCalledWith({ limit: 50, offset: 0 });
    expect(search).not.toHaveBeenCalled();
  });

  it('uses the search branch when q meets MIN_QUERY_LENGTH and re-orders rows to id rank', async () => {
    const search = jest.fn().mockResolvedValue({ ids: ['b', 'a'], total: 2 });
    const hydrate = jest.fn().mockResolvedValue([{ id: 'a', n: 1 }, { id: 'b', n: 2 }]);
    const page = jest.fn();
    const res = await listPaginated({ q: 'foo', limit: 10, offset: 5, present, search, hydrate, page });
    expect(res.data).toEqual([{ id: 'b', doubled: 4 }, { id: 'a', doubled: 2 }]);
    expect(res).toMatchObject({ total: 2, limit: 10, offset: 5 });
    expect(page).not.toHaveBeenCalled();
  });

  it('drops ids hydrate cannot resolve (concurrent soft-delete)', async () => {
    const res = await listPaginated({
      q: 'foo', present,
      search: jest.fn().mockResolvedValue({ ids: ['a', 'gone'], total: 2 }),
      hydrate: jest.fn().mockResolvedValue([{ id: 'a', n: 1 }]),
      page: jest.fn(),
    });
    expect(res.data).toEqual([{ id: 'a', doubled: 2 }]);
  });

  it('skips hydrate when search returns no ids', async () => {
    const hydrate = jest.fn();
    const res = await listPaginated({
      q: 'zzz', present, hydrate,
      search: jest.fn().mockResolvedValue({ ids: [], total: 0 }),
      page: jest.fn(),
    });
    expect(res.data).toEqual([]);
    expect(hydrate).not.toHaveBeenCalled();
  });

  it('treats a sub-MIN_QUERY_LENGTH term (1 char) as no search', async () => {
    const page = jest.fn().mockResolvedValue({ rows: [], total: 0 });
    const search = jest.fn();
    await listPaginated({ q: 'a', present, search, hydrate: jest.fn(), page });
    expect(page).toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it('uses the page branch when no search closure is provided (search-less endpoint)', async () => {
    const page = jest.fn().mockResolvedValue({ rows: [{ id: 'a', n: 2 }], total: 1 });
    const res = await listPaginated({ q: 'anything', present, page });
    expect(res.data).toEqual([{ id: 'a', doubled: 4 }]);
    expect(page).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/common/pagination/paginated.spec.ts`
Expected: FAIL — `Cannot find module './paginated'`.

- [ ] **Step 3: Write the constants**

```ts
// src/common/pagination/pagination.constants.ts
/** Default page size applied when a list request omits `limit`. */
export const DEFAULT_PAGE_SIZE = 50;
/** Hard upper bound on `limit` (enforced by PaginationQueryDto's @Max). */
export const MAX_LIMIT = 200;
```

- [ ] **Step 4: Write the seam**

```ts
// src/common/pagination/paginated.ts
import { MIN_QUERY_LENGTH } from '../search/trigram-search';
import { DEFAULT_PAGE_SIZE } from './pagination.constants';

export interface Paginated<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ListPaginatedParams<TRow extends { id: string }, TOut> {
  q?: string;
  limit?: number;
  offset?: number;
  /** Map a hydrated row to its response shape. */
  present: (row: TRow) => TOut;
  /** Relevance-ranked id search; provide for endpoints with fuzzy ?q= support. Omit to disable search entirely (search-less endpoints like accounts/tax-codes). */
  search?: (args: { term: string; limit: number; offset: number }) => Promise<{ ids: string[]; total: number }>;
  /** Hydrate full rows for the ranked ids (order not guaranteed; the seam re-orders to the id rank). Required iff `search` is provided. */
  hydrate?: (ids: string[]) => Promise<TRow[]>;
  /** Non-search branch: a page of rows + the matching total. */
  page: (args: { limit: number; offset: number }) => Promise<{ rows: TRow[]; total: number }>;
}

/**
 * Shared offset-pagination + optional fuzzy-search list seam. Owns the
 * limit/offset defaulting, the MIN_QUERY_LENGTH branch, the relevance-rank
 * re-order (dropping ids that fail to hydrate), and the envelope assembly.
 * Callers supply Prisma-typed `search`/`hydrate`/`page` closures + a presenter.
 */
export async function listPaginated<TRow extends { id: string }, TOut>(
  params: ListPaginatedParams<TRow, TOut>,
): Promise<Paginated<TOut>> {
  const limit = params.limit ?? DEFAULT_PAGE_SIZE;
  const offset = params.offset ?? 0;
  const term = params.q?.trim() ?? '';
  if (term.length >= MIN_QUERY_LENGTH && params.search && params.hydrate) {
    const { ids, total } = await params.search({ term, limit, offset });
    const rows = ids.length ? await params.hydrate(ids) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const data = ids
      .map((id) => byId.get(id))
      .filter((r): r is TRow => r !== undefined)
      .map(params.present);
    return { data, total, limit, offset };
  }
  const { rows, total } = await params.page({ limit, offset });
  return { data: rows.map(params.present), total, limit, offset };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/common/pagination/paginated.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/common/pagination
git commit -m "feat(common): add listPaginated seam + pagination constants"
```

---

### Task 2: `serializeMoney` seam

**Files:**
- Create: `src/common/money/serialize-money.ts`
- Test: `src/common/money/serialize-money.spec.ts`

**Interfaces:**
- Consumes: `Money` from `./money`.
- Produces: `serializeMoney<T extends object>(obj: T, fields: (keyof T)[]): T` — shallow copy with the named fields rendered to 4dp strings; the single `as unknown` cast that the 11 `present()` sites currently each carry now lives only here.

- [ ] **Step 1: Write the failing test**

```ts
// src/common/money/serialize-money.spec.ts
import { Prisma } from '@prisma/client';
import { serializeMoney } from './serialize-money';

describe('serializeMoney', () => {
  it('renders named string fields to fixed 4dp', () => {
    const out = serializeMoney({ id: 'x', amount: '10.5', other: 7 }, ['amount']);
    expect(out).toEqual({ id: 'x', amount: '10.5000', other: 7 });
  });

  it('renders Prisma.Decimal fields to fixed 4dp', () => {
    const out = serializeMoney({ total: new Prisma.Decimal('1234.5') } as { total: Prisma.Decimal }, ['total']);
    expect(out.total as unknown as string).toBe('1234.5000');
  });

  it('passes through null/undefined named fields untouched', () => {
    const out = serializeMoney({ a: null as string | null }, ['a']);
    expect(out.a).toBeNull();
  });

  it('does not mutate the input object', () => {
    const input = { amount: '1' };
    serializeMoney(input, ['amount']);
    expect(input.amount).toBe('1');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/common/money/serialize-money.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/common/money/serialize-money.ts
import { Money } from './money';

/**
 * Returns a shallow copy of `obj` with each named field rendered to a fixed
 * 4-decimal money string via Money. null/undefined named fields pass through.
 * Other fields are untouched. This is the single home for the Decimal→string
 * money cast that the document presenters used to repeat per field.
 */
export function serializeMoney<T extends object>(obj: T, fields: (keyof T)[]): T {
  const out: T = { ...obj };
  for (const f of fields) {
    const v = obj[f];
    if (v !== null && v !== undefined) {
      (out[f] as unknown) = Money.of(String(v)).toPersistence();
    }
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/common/money/serialize-money.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/common/money/serialize-money.ts src/common/money/serialize-money.spec.ts
git commit -m "feat(common): add serializeMoney seam"
```

---

### Task 3: `@IdempotentWrite()` composed decorator

**Files:**
- Create: `src/common/idempotency/idempotent-write.decorator.ts`
- Test: `src/common/idempotency/idempotent-write.decorator.spec.ts`

**Interfaces:**
- Consumes: `Idempotent`, `IDEMPOTENT_KEY` from `./idempotent.decorator`; `ApiHeader` from `@nestjs/swagger`; `applyDecorators` from `@nestjs/common`.
- Produces: `IdempotentWrite()` — composes the exact `@ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Unique key to make this write safely retryable.' })` + `@Idempotent()` pair used verbatim at all 14 sites.

- [ ] **Step 1: Write the failing test**

```ts
// src/common/idempotency/idempotent-write.decorator.spec.ts
import 'reflect-metadata';
import { IdempotentWrite } from './idempotent-write.decorator';
import { IDEMPOTENT_KEY } from './idempotent.decorator';

class Sample {
  @IdempotentWrite()
  create() {}
}

describe('IdempotentWrite', () => {
  it('marks the handler idempotent (IDEMPOTENT_KEY = true)', () => {
    expect(Reflect.getMetadata(IDEMPOTENT_KEY, Sample.prototype.create)).toBe(true);
  });

  it('registers the required Idempotency-Key api header', () => {
    const headers = Reflect.getMetadata('swagger/apiHeaders', Sample.prototype.create) as
      | { name: string; required: boolean }[]
      | undefined;
    expect(headers).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Idempotency-Key', required: true })]),
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/common/idempotency/idempotent-write.decorator.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/common/idempotency/idempotent-write.decorator.ts
import { applyDecorators } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { Idempotent } from './idempotent.decorator';

/**
 * Composed decorator for write handlers: documents the required Idempotency-Key
 * header (OpenAPI) AND marks the handler for the global IdempotencyInterceptor.
 * Replaces the hand-paired @ApiHeader(...) + @Idempotent() block (14 sites).
 */
export function IdempotentWrite() {
  return applyDecorators(
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      description: 'Unique key to make this write safely retryable.',
    }),
    Idempotent(),
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/common/idempotency/idempotent-write.decorator.spec.ts`
Expected: PASS (2 tests). If the `swagger/apiHeaders` metadata key differs in this `@nestjs/swagger` version, log the actual key via `Reflect.getMetadataKeys(Sample.prototype.create)` and update the assertion's key — do not change the decorator.

- [ ] **Step 5: Commit**

```bash
git add src/common/idempotency/idempotent-write.decorator.ts src/common/idempotency/idempotent-write.decorator.spec.ts
git commit -m "feat(common): add @IdempotentWrite composed decorator"
```

---

### Task 4: Date helpers (`truncateToUtcDay`, `fiscalYearForDate`)

**Files:**
- Create: `src/common/dates/utc-day.ts`
- Create: `src/common/dates/fiscal-year.ts`
- Test: `src/common/dates/utc-day.spec.ts`
- Test: `src/common/dates/fiscal-year.spec.ts`

**Interfaces:**
- Produces: `truncateToUtcDay(d: Date): Date` (UTC-midnight truncation, byte-equivalent to the 5 inlined sites); `fiscalYearForDate(date: Date, startMonth: number): number` (pure form of `PostingService.fiscalYearFor`).

- [ ] **Step 1: Write the failing tests**

```ts
// src/common/dates/utc-day.spec.ts
import { truncateToUtcDay } from './utc-day';

describe('truncateToUtcDay', () => {
  it('drops the time-of-day in UTC', () => {
    expect(truncateToUtcDay(new Date('2026-03-15T13:45:30.500Z')).toISOString()).toBe('2026-03-15T00:00:00.000Z');
  });
  it('is idempotent on an already-truncated date', () => {
    const d = new Date('2026-03-15T00:00:00.000Z');
    expect(truncateToUtcDay(d).toISOString()).toBe('2026-03-15T00:00:00.000Z');
  });
});
```

```ts
// src/common/dates/fiscal-year.spec.ts
import { fiscalYearForDate } from './fiscal-year';

describe('fiscalYearForDate', () => {
  it('returns the calendar year when month >= start month', () => {
    expect(fiscalYearForDate(new Date('2026-07-01T00:00:00Z'), 7)).toBe(2026);
  });
  it('returns the prior year when month < start month', () => {
    expect(fiscalYearForDate(new Date('2026-06-30T00:00:00Z'), 7)).toBe(2025);
  });
  it('handles a January start month (calendar year)', () => {
    expect(fiscalYearForDate(new Date('2026-12-31T00:00:00Z'), 1)).toBe(2026);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/common/dates`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement both helpers**

```ts
// src/common/dates/utc-day.ts
/** Truncate a Date to UTC midnight (drops time-of-day). */
export function truncateToUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
```

```ts
// src/common/dates/fiscal-year.ts
/** Fiscal year that a date falls into, given the configured start month (1-12). */
export function fiscalYearForDate(date: Date, startMonth: number): number {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  return m >= startMonth ? y : y - 1;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx jest src/common/dates`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/common/dates
git commit -m "feat(common): add truncateToUtcDay + fiscalYearForDate helpers"
```

---

### Task 5: `mapUniqueViolation` helper

**Files:**
- Create: `src/common/errors/map-unique-violation.ts`
- Test: `src/common/errors/map-unique-violation.spec.ts`

**Interfaces:**
- Consumes: `Prisma` from `@prisma/client`; `ConflictDomainError` from `./domain-errors`.
- Produces: `mapUniqueViolation(err: unknown, message: string, context?: Record<string, unknown>): never` — on `P2002` throws `ConflictDomainError` (409); otherwise rethrows `err`.

> Note: before writing, open `src/common/errors/domain-errors.ts` and confirm `ConflictDomainError`'s constructor is `(message: string, context?: Record<string, unknown>)`. If the context param name/shape differs, match it.

- [ ] **Step 1: Write the failing test**

```ts
// src/common/errors/map-unique-violation.spec.ts
import { Prisma } from '@prisma/client';
import { mapUniqueViolation } from './map-unique-violation';
import { ConflictDomainError } from './domain-errors';

const p2002 = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });

describe('mapUniqueViolation', () => {
  it('throws a 409 ConflictDomainError on P2002', () => {
    expect(() => mapUniqueViolation(p2002, 'Account code already exists')).toThrow(ConflictDomainError);
  });
  it('rethrows non-P2002 errors unchanged', () => {
    const other = new Error('boom');
    expect(() => mapUniqueViolation(other, 'x')).toThrow(other);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/common/errors/map-unique-violation.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/common/errors/map-unique-violation.ts
import { Prisma } from '@prisma/client';
import { ConflictDomainError } from './domain-errors';

/**
 * Rethrows a Prisma P2002 (unique constraint) as a 409 ConflictDomainError with
 * a friendly message; rethrows anything else unchanged. Replaces the repeated
 * `instanceof PrismaClientKnownRequestError && code === 'P2002'` catch blocks.
 */
export function mapUniqueViolation(
  err: unknown,
  message: string,
  context?: Record<string, unknown>,
): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    throw new ConflictDomainError(message, context);
  }
  throw err;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/common/errors/map-unique-violation.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/common/errors/map-unique-violation.ts src/common/errors/map-unique-violation.spec.ts
git commit -m "feat(common): add mapUniqueViolation helper"
```

---

### Task 6: Shared small helpers — `taxableLines`, control-account, doc-ref, raw-tx type

**Files:**
- Create: `src/invoicing/document-helpers.ts` (taxableLines mapper + control-account constants/lookup)
- Create: `src/common/db/raw-tx.ts` (shared `RawTx` type)
- Modify: `src/invoicing/document-number.service.ts` (export `buildRef` reuse; import `RawTx`)
- Test: `src/invoicing/document-helpers.spec.ts`

**Interfaces:**
- Produces:
  - `taxableLines(lines): { accountId: string; amount: string; taxCodeIds: string[] }[]` — the byte-identical mapper from sales/purchase.
  - `AR_CONTROL_CODE = '1-1200'`, `AP_CONTROL_CODE = '2-1000'` (single source).
  - `findControlAccountId(prisma: PrismaService, code: string): Promise<string>` — the generalized lookup (payments' `controlId` shape).
  - `RawTx` type (the structural `{ $executeRaw; $queryRaw }` shape) in `src/common/db/raw-tx.ts`, replacing the two private `RawTx`/`RawTxClient` copies.

- [ ] **Step 1: Write the failing test (pure mapper + constants)**

```ts
// src/invoicing/document-helpers.spec.ts
import { Prisma } from '@prisma/client';
import { taxableLines, AR_CONTROL_CODE, AP_CONTROL_CODE } from './document-helpers';

describe('taxableLines', () => {
  it('maps quantity*unitPrice to a 4dp amount and carries accountId + taxCodeIds', () => {
    const out = taxableLines([
      { accountId: 'acc-1', quantity: new Prisma.Decimal('3'), unitPrice: new Prisma.Decimal('1000.5'), taxCodeIds: ['t1'] },
    ]);
    expect(out).toEqual([{ accountId: 'acc-1', amount: '3001.5000', taxCodeIds: ['t1'] }]);
  });
});

describe('control-account constants', () => {
  it('pins AR/AP control codes', () => {
    expect(AR_CONTROL_CODE).toBe('1-1200');
    expect(AP_CONTROL_CODE).toBe('2-1000');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/invoicing/document-helpers.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the shared `RawTx` type**

```ts
// src/common/db/raw-tx.ts
/** Minimal tx surface for parameterized raw SQL inside a Prisma $transaction. */
export type RawTx = {
  $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number>;
  $queryRaw: <T = unknown>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
};
```

- [ ] **Step 4: Create the document helpers**

```ts
// src/invoicing/document-helpers.ts
import { Prisma } from '@prisma/client';
import { Money } from '../common/money/money';
import { PrismaService } from '../common/prisma/prisma.service';
import { ValidationFailedError } from '../common/errors/domain-errors';

/** AR control account code in the chart of accounts. */
export const AR_CONTROL_CODE = '1-1200';
/** AP control account code in the chart of accounts. */
export const AP_CONTROL_CODE = '2-1000';

type TaxableLineInput = {
  accountId: string;
  quantity: Prisma.Decimal | string;
  unitPrice: Prisma.Decimal | string;
  taxCodeIds: string[];
};

/** Maps document lines to the tax engine's taxable-line shape (amount = qty*unitPrice, 4dp). */
export function taxableLines(lines: TaxableLineInput[]) {
  return lines.map((l) => ({
    accountId: l.accountId,
    amount: Money.of(l.unitPrice.toString()).multiply(l.quantity.toString()).toPersistence(),
    taxCodeIds: l.taxCodeIds,
  }));
}

/** Resolves a control account's id by chart code; 422 if it is missing. */
export async function findControlAccountId(prisma: PrismaService, code: string): Promise<string> {
  const acc = await prisma.client.account.findFirst({ where: { code } });
  if (!acc) {
    throw new ValidationFailedError('Control account missing from chart', { code });
  }
  return acc.id;
}
```

- [ ] **Step 5: Run to verify the test passes**

Run: `npx jest src/invoicing/document-helpers.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Point `document-number.service.ts` at the shared `RawTx`**

In `src/invoicing/document-number.service.ts`: delete the local `type RawTx = { ... }` (lines ~4-10) and add `import { RawTx } from '../common/db/raw-tx';`. Keep `buildRef(prefix, fiscalYear, number)` as-is (it is the general form; `PostingService.buildEntryRef` will delegate to it in Task 8).

- [ ] **Step 7: Typecheck**

Run: `npm run db:generate && npm run typecheck`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add src/common/db/raw-tx.ts src/invoicing/document-helpers.ts src/invoicing/document-helpers.spec.ts src/invoicing/document-number.service.ts
git commit -m "feat(invoicing): add taxableLines/control-account helpers + shared RawTx type"
```

---

### Task 7: `DocumentLifecycleService` — shared `softDeleteDraft` + `reverseWithGuard`

**Files:**
- Create: `src/invoicing/document-lifecycle.service.ts`
- Modify: `src/invoicing/invoicing.module.ts` (provide + export `DocumentLifecycleService`), `src/ledger/journal/journal.module.ts` (import the module/provider for journal's `deleteDraft`)
- Test: `src/invoicing/document-lifecycle.service.spec.ts` (unit test for `softDeleteDraft`)

**Interfaces:**
- Consumes: `PrismaService`; `PostingService` + `LedgerTx` (`src/ledger/posting/posting.service.ts`); `ValidationFailedError` from `src/common/errors/domain-errors`.
- Produces:
  - `softDeleteDraft(model, id, deletedBy, noun): Promise<void>` — conditional `updateMany` guard (`where: { id, status: 'DRAFT', deletedAt: null }`; throws `ValidationFailedError('Only a DRAFT <noun> can be deleted', { id })` when `count !== 1`).
  - `reverseWithGuard<TLocked extends { status: string; journalEntryId: string }>(opts): Promise<void>` — runs `prepareReversal` outside the tx, opens `prisma.client.$transaction`, calls `lock(tx)` (caller's `SELECT … FOR UPDATE`), re-checks `status === 'POSTED'`, runs `applyInTx(tx, locked)`, then `posting.reverseInTx(...)`; catches Prisma `P2002` and throws `ValidationFailedError(alreadyReversedMessage, { id })`.

> **This is the highest-risk task.** `softDeleteDraft` is fully generic (the four current bodies differ only by model + noun). `reverseWithGuard` consolidates the three `void()` skeletons, but **payments' `void()` differs** (it re-locks each allocated invoice/bill and decrements `amountPaid` inside the tx) — that divergence goes in the caller's `applyInTx` hook, not the shared helper. Before writing, **read the three current `void()` bodies** (`sales-invoices.service.ts:343-400`, `purchase-bills.service.ts:347-403`, `payments.service.ts:431-492`) so the consolidated skeleton preserves each behavior exactly. The e2e void tests are the gate.

- [ ] **Step 1: Write the failing unit test (softDeleteDraft)**

```ts
// src/invoicing/document-lifecycle.service.spec.ts
import { DocumentLifecycleService } from './document-lifecycle.service';
import { ValidationFailedError } from '../common/errors/domain-errors';

describe('DocumentLifecycleService.softDeleteDraft', () => {
  const svc = new DocumentLifecycleService({} as never, {} as never);

  it('soft-deletes when exactly one DRAFT row matches', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    await expect(svc.softDeleteDraft({ updateMany }, 'id-1', 'user-1', 'invoice')).resolves.toBeUndefined();
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'id-1', status: 'DRAFT', deletedAt: null },
      data: expect.objectContaining({ deletedBy: 'user-1' }),
    });
  });

  it('throws ValidationFailedError when no DRAFT row matches (count !== 1)', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    await expect(svc.softDeleteDraft({ updateMany }, 'id-1', 'user-1', 'bill')).rejects.toBeInstanceOf(ValidationFailedError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/invoicing/document-lifecycle.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

```ts
// src/invoicing/document-lifecycle.service.ts
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { PostingService, LedgerTx } from '../ledger/posting/posting.service';
import { ValidationFailedError } from '../common/errors/domain-errors';

type SoftDeletableModel = {
  updateMany: (args: {
    where: { id: string; status: 'DRAFT'; deletedAt: null };
    data: { deletedAt: Date; deletedBy: string };
  }) => Promise<{ count: number }>;
};

@Injectable()
export class DocumentLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
  ) {}

  /**
   * Soft-deletes a DRAFT document. The `status: 'DRAFT', deletedAt: null`
   * predicate is the optimistic concurrency guard: a concurrent post flips
   * status so count===0 and we 422. Mirrors the per-service deleteDraft().
   */
  async softDeleteDraft(
    model: SoftDeletableModel,
    id: string,
    deletedBy: string,
    noun: string,
  ): Promise<void> {
    const res = await model.updateMany({
      where: { id, status: 'DRAFT', deletedAt: null },
      data: { deletedAt: new Date(), deletedBy },
    });
    if (res.count !== 1) {
      throw new ValidationFailedError(`Only a DRAFT ${noun} can be deleted`, { id });
    }
  }

  /**
   * Reverses a posted document's journal entry with a FOR UPDATE race guard.
   * Mirrors the existing void(): prepareReversal runs OUTSIDE the tx (it does
   * its own period/closed-year resolution); lock()/applyInTx()/reverseInTx()
   * run inside. A lost reversal race (Prisma P2002 on the unique reversal_of_id)
   * becomes a 422 ValidationFailedError(alreadyReversedMessage). The caller
   * keeps its own preconditions (status POSTED, payments/allocations checks)
   * and passes the document's journalEntryId in.
   */
  async reverseWithGuard<TLocked extends { status: string }>(opts: {
    id: string;
    journalEntryId: string;
    reversedBy: string;
    reversalDate?: Date;
    alreadyReversedMessage: string;
    notPostedMessage: string;
    /** SELECT ... FOR UPDATE the document row (deleted_at IS NULL) and return it, or undefined. */
    lock: (tx: LedgerTx) => Promise<TLocked | undefined>;
    /** Per-document in-tx side effects BEFORE reverseInTx (e.g. set status VOID; unwind allocations). */
    applyInTx: (tx: LedgerTx, locked: TLocked) => Promise<void>;
  }): Promise<void> {
    const prepared = await this.posting.prepareReversal(opts.journalEntryId, opts.reversalDate);
    try {
      await this.prisma.client.$transaction(async (tx) => {
        const ltx = tx as unknown as LedgerTx;
        const locked = await opts.lock(ltx);
        if (!locked || locked.status !== 'POSTED') {
          throw new ValidationFailedError(opts.notPostedMessage, { id: opts.id });
        }
        await opts.applyInTx(ltx, locked);
        await this.posting.reverseInTx(
          ltx,
          prepared.original,
          opts.reversedBy,
          prepared.periodId,
          prepared.fiscalYear,
          prepared.reversalDate,
        );
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ValidationFailedError(opts.alreadyReversedMessage, { id: opts.id });
      }
      throw err;
    }
  }
}
```

> **Implementer note:** While migrating each `void()` (Tasks 9–11), read the original body first and preserve every precondition check and message string in the caller. The helper above mirrors the originals' structure (prepareReversal outside the tx; lock + recheck + side-effects + reverseInTx inside; P2002→422). **Behavior parity with the existing void e2e tests is the acceptance criterion — adjust this helper to match the originals if any test regresses, never the reverse.** If `payments.void` needs `$transaction` options (`{ maxWait, timeout }`), they apply only to `payments.post`, not `void` — the default tx options here are correct.

- [ ] **Step 4: Run the unit test to verify softDeleteDraft passes**

Run: `npx jest src/invoicing/document-lifecycle.service.spec.ts`
Expected: PASS (2 tests). (Delete the `locked0` placeholder first so the file compiles.)

- [ ] **Step 5: Wire the provider**

In `src/invoicing/invoicing.module.ts`: add `DocumentLifecycleService` to `providers` and `exports`. In `src/ledger/journal/journal.module.ts`: import `InvoicingModule` (or move `DocumentLifecycleService` to a shared module if that creates a cycle — if `InvoicingModule` already imports the ledger/posting module, prefer providing `DocumentLifecycleService` directly in `journal.module.ts` providers to avoid a circular import).

- [ ] **Step 6: Typecheck**

Run: `npm run db:generate && npm run typecheck`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/invoicing/document-lifecycle.service.ts src/invoicing/document-lifecycle.service.spec.ts src/invoicing/invoicing.module.ts src/ledger/journal/journal.module.ts
git commit -m "feat(invoicing): add DocumentLifecycleService (softDeleteDraft + reverseWithGuard)"
```

---

## Phase 2 — Migrate consumers onto the seams

> Each Phase-2 task is a behavior-preserving refactor: the **acceptance gate is that the existing unit + e2e tests stay green**. Run the named e2e spec after each, then the full suite before the phase's final commit.

### Task 8: Posting/number unification + reporting fiscalYear/date sites

**Files:**
- Modify: `src/ledger/posting/posting.service.ts` (delete local `RawTxClient`; import shared `RawTx`; make `buildEntryRef` delegate to `buildRef`; keep `fiscalYearFor` but delegate to `fiscalYearForDate`)
- Modify: `src/reporting/balance-sheet.service.ts:61-65` and `src/ledger/periods/periods.service.ts:22-26` (use `fiscalYearForDate`)
- Modify: `src/ledger/balances/balances.service.ts:60-64`, `src/reporting/aging.service.ts:23-27`, `src/reporting/general-ledger.service.ts:24-28`, `src/ledger/periods/periods.service.ts:71-73`, `src/reporting/cash-flow.service.ts:85-88` (use `truncateToUtcDay`)

- [ ] **Step 1: Unify the raw-tx type + doc-ref in posting**

In `posting.service.ts`: delete `type RawTxClient = {...}` (lines ~26-35); `import { RawTx } from '../../common/db/raw-tx';` and replace `RawTxClient` references with `RawTx`. Replace the `buildEntryRef` body:

```ts
  /** Human-readable posted-entry reference, e.g. JE/2026/000123. */
  private buildEntryRef(fiscalYear: number, entryNumber: number): string {
    return buildRef('JE', fiscalYear, entryNumber);
  }
```

…importing `buildRef` from `../../invoicing/document-number.service` if no cycle exists; if it does, move `buildRef` to a shared `src/common/db/doc-ref.ts` and import it in both places. Then make `fiscalYearFor` delegate:

```ts
  fiscalYearFor(date: Date, startMonth: number): number {
    return fiscalYearForDate(date, startMonth);
  }
```

with `import { fiscalYearForDate } from '../../common/dates/fiscal-year';`.

- [ ] **Step 2: Replace the two inline fiscalYear reimplementations**

`balance-sheet.service.ts:61-65` becomes:
```ts
    const fy = fiscalYearForDate(asOf, settings.fiscalYearStartMonth);
```
`periods.service.ts:22-26` becomes:
```ts
    const fiscalYear = fiscalYearForDate(now, settings.fiscalYearStartMonth);
```
(add `import { fiscalYearForDate } from '../../common/dates/fiscal-year';` to each — adjust relative depth).

- [ ] **Step 3: Replace the five UTC-truncation sites with `truncateToUtcDay`**

- `balances.service.ts`: replace the `toUtcDay` method body with `return truncateToUtcDay(d);` (or delete the method and call `truncateToUtcDay` directly).
- `aging.service.ts` / `general-ledger.service.ts`: replace each `day(d)` body with `return truncateToUtcDay(d);`.
- `periods.service.ts:71-73`: `const d = truncateToUtcDay(date);`
- `cash-flow.service.ts:85-88`: `const dayBefore = new Date(truncateToUtcDay(from).getTime() - 86_400_000);`
- Add `import { truncateToUtcDay } from '...'/common/dates/utc-day';` to each (adjust depth).

- [ ] **Step 4: Typecheck + run affected e2e + unit**

Run: `npm run db:generate && npm run typecheck && npm test`
Then: `npm run test:e2e -- "reports|periods|ledger|balances|posting"`
Expected: all green (these helpers are byte-equivalent to the originals).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: route posting/reporting through shared RawTx/buildRef/date/fiscalYear seams"
```

---

### Task 9: Migrate `sales-invoices.service.ts` onto the seams

**Files:**
- Modify: `src/invoicing/sales-invoices.service.ts`

**Interfaces:**
- Consumes: `listPaginated`, `serializeMoney`, `taxableLines`, `findControlAccountId`, `AR_CONTROL_CODE`, `mapUniqueViolation`, `DocumentLifecycleService`.

- [ ] **Step 1: Inject `DocumentLifecycleService`**

Add `private readonly lifecycle: DocumentLifecycleService,` to the constructor (after `posting`). Remove the local `AR_CONTROL_CODE` const (line 18) and `arControlId()` method (51-60) and `taxableLines()` (62-77) — import the shared ones from `./document-helpers`.

- [ ] **Step 2: Replace `present()` (lines 400-446) to drop all 5 casts**

```ts
  present(inv: SalesInvoice): SalesInvoice & { outstanding: string; paymentStatus: string } {
    const total = Money.of(inv.total.toString());
    const paid = Money.of(inv.amountPaid.toString());
    const outstanding = total.subtract(paid);
    const paymentStatus = paid.isZero()
      ? 'UNPAID'
      : outstanding.isZero() || outstanding.isNegative()
        ? 'PAID'
        : 'PARTIAL';
    const lines = (inv as SalesInvoice & { lines?: Record<string, unknown>[] }).lines;
    return {
      ...serializeMoney(inv, ['subtotal', 'taxTotal', 'withholdingTotal', 'total', 'amountPaid']),
      ...(lines
        ? { lines: lines.map((l) => serializeMoney(l, ['quantity', 'unitPrice', 'amount'])) }
        : {}),
      outstanding: outstanding.toPersistence(),
      paymentStatus,
    } as SalesInvoice & { outstanding: string; paymentStatus: string };
  }
```

- [ ] **Step 3: Replace `listPage()` (lines 191-248) with a `listPaginated` call**

```ts
  async listPage(q: {
    q?: string;
    partnerId?: string;
    status?: DocumentStatus;
    limit?: number;
    offset?: number;
  }) {
    const filters: Prisma.Sql[] = [];
    if (q.partnerId) filters.push(Prisma.sql`t.partner_id = ${q.partnerId}`);
    if (q.status) filters.push(Prisma.sql`t.status::text = ${q.status}`);
    const where = { partnerId: q.partnerId, status: q.status };
    return listPaginated({
      q: q.q,
      limit: q.limit,
      offset: q.offset,
      present: (r: SalesInvoice) => this.present(r),
      search: ({ term, limit, offset }) =>
        trigramSearch(this.prisma, {
          table: 'sales_invoices',
          alias: 't',
          ownColumns: ['invoice_ref', 'description'],
          join: { table: 'business_partners', alias: 'p', onColumn: 'partner_id', columns: ['name'] },
          filters,
          q: term,
          limit,
          offset,
        }),
      hydrate: (ids) => this.prisma.client.salesInvoice.findMany({ where: { id: { in: ids } } }),
      page: async ({ limit, offset }) => {
        const [rows, total] = await Promise.all([
          this.prisma.client.salesInvoice.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
          this.prisma.client.salesInvoice.count({ where }),
        ]);
        return { rows, total };
      },
    });
  }
```

- [ ] **Step 4: Replace `void()` (343-400) with `lifecycle.reverseWithGuard`**

Keep the caller-side precondition checks (status POSTED, not-already-reversed, "no payments" conflict) exactly as they are today, read the invoice's `journalEntryId`, then delegate the tx/lock/reverse to `this.lifecycle.reverseWithGuard({ id, journalEntryId, reversedBy, alreadyReversedMessage, notPostedMessage, lock, applyInTx })` where `lock` is the existing `SELECT status FROM sales_invoices WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE` and `applyInTx` sets `status: 'VOID'` on the invoice. **Read the current body and preserve every message string and check.**

- [ ] **Step 5: Replace `deleteDraft()` (250) with the shared helper**

```ts
  async deleteDraft(id: string, deletedBy: string): Promise<void> {
    return this.lifecycle.softDeleteDraft(this.prisma.client.salesInvoice, id, deletedBy, 'invoice');
  }
```

- [ ] **Step 6: Replace the `create()` P2002 try/catch (around line 385)**

Replace the `if (err instanceof Prisma...P2002) throw ...; throw err;` block with `mapUniqueViolation(err, '<the existing friendly message>', { /* existing context */ })`. Preserve the existing message text.

- [ ] **Step 7: Add imports**

```ts
import { listPaginated } from '../common/pagination/paginated';
import { serializeMoney } from '../common/money/serialize-money';
import { taxableLines, findControlAccountId, AR_CONTROL_CODE } from './document-helpers';
import { mapUniqueViolation } from '../common/errors/map-unique-violation';
import { DocumentLifecycleService } from './document-lifecycle.service';
```
Replace internal `this.arControlId()` calls with `findControlAccountId(this.prisma, AR_CONTROL_CODE)` and `this.taxableLines(...)` with `taxableLines(...)`.

- [ ] **Step 8: Typecheck + run sales e2e + unit**

Run: `npm run db:generate && npm run typecheck && npm test`
Then: `npm run test:e2e -- sales-invoices`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/invoicing/sales-invoices.service.ts
git commit -m "refactor(invoicing): migrate sales-invoices onto shared seams"
```

---

### Task 10: Migrate `purchase-bills.service.ts` onto the seams

**Files:** Modify `src/invoicing/purchase-bills.service.ts`.

Apply the same six transformations as Task 9, adapted to purchase bills:
- `present()` (403-449): same body as Task 9 Step 2 but typed `PurchaseBill` (same five money fields, same nested-lines handling).
- `listPage()` (195-252): same as Task 9 Step 3 but `table: 'purchase_bills'`, `ownColumns: ['bill_ref', 'vendor_invoice_no', 'description']`, model `this.prisma.client.purchaseBill`.
- `void()` (347-403): delegate to `lifecycle.reverseWithGuard`, `applyInTx` sets `status: 'VOID'` on the bill; preserve the "no payments" conflict + message strings.
- `deleteDraft()` (254): `return this.lifecycle.softDeleteDraft(this.prisma.client.purchaseBill, id, deletedBy, 'bill');`
- Remove local `AP_CONTROL_CODE` (18), `apControlId()` (53-62), `taxableLines()` (64-79); import from `./document-helpers`; use `findControlAccountId(this.prisma, AP_CONTROL_CODE)`.
- `create()` P2002 catch (~388): `mapUniqueViolation(err, '<existing message>', {...})`.
- Inject `DocumentLifecycleService`; add the same imports as Task 9 Step 7.

- [ ] **Step 1: Apply the edits above.**
- [ ] **Step 2: Typecheck + e2e + unit**

Run: `npm run db:generate && npm run typecheck && npm test`
Then: `npm run test:e2e -- purchase-bills`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add src/invoicing/purchase-bills.service.ts
git commit -m "refactor(invoicing): migrate purchase-bills onto shared seams"
```

---

### Task 11: Migrate `payments.service.ts` onto the seams

**Files:** Modify `src/invoicing/payments.service.ts`.

- `present()` (546-564): use `serializeMoney(payment, ['amount'])` for the top-level field and `serializeMoney(a, ['amount'])` for nested allocations; preserve the `allocations?` optional handling. Drops the 1 cast.
- `listPage()` (200-264): `listPaginated` call with `table: 'payments'`, `ownColumns: ['ref', 'description']`, the `direction`/`partnerId`/`status` filters and `where` exactly as today; model `this.prisma.client.payment`.
- `void()` (431-492): delegate to `lifecycle.reverseWithGuard`; its `applyInTx` must reproduce payments' divergent in-tx work — **re-lock each allocated invoice/bill `FOR UPDATE` and decrement `amountPaid`, guard against negative (the existing `ConflictDomainError('Void would drive amountPaid negative')`), then set the payment `status: 'VOID'`**. Read the current body and preserve all of it inside `applyInTx`.
- `deleteDraft()` (261): `return this.lifecycle.softDeleteDraft(this.prisma.client.payment, id, deletedBy, 'payment');`
- Remove local `AR_CONTROL_CODE`/`AP_CONTROL_CODE` (23-24) and `controlId()` (50-57); import the constants + `findControlAccountId` from `./document-helpers`; the call site (299-302) becomes `await findControlAccountId(this.prisma, isReceipt ? AR_CONTROL_CODE : AP_CONTROL_CODE)`.
- `create()` P2002 catch (~532): `mapUniqueViolation(err, '<existing message>', {...})`.
- Inject `DocumentLifecycleService`.

- [ ] **Step 1: Apply the edits above** (payments' `void` is the most divergent — keep its allocation-unwind logic verbatim inside `applyInTx`).
- [ ] **Step 2: Typecheck + e2e + unit**

Run: `npm run db:generate && npm run typecheck && npm test`
Then: `npm run test:e2e -- payments`
Expected: all green — **especially the void/allocation and the payments-flake tests**.

- [ ] **Step 3: Commit**

```bash
git add src/invoicing/payments.service.ts
git commit -m "refactor(invoicing): migrate payments onto shared seams"
```

---

### Task 12: Migrate `journal.service.ts` (`list` + `deleteDraft`)

**Files:** Modify `src/ledger/journal/journal.service.ts`.

- `list(filter)` (190-257): rewrite as a `listPaginated` call. `present` is `(r) => this.present(r)` (journal keeps its own `present` at line 259, unchanged). `search` calls `trigramSearch` with `table: 'journal_entries'`, `ownColumns: ['entry_ref', 'description']`, the existing status/sourceType/fiscalYear/from/to filters; `hydrate` is `this.prisma.client.journalEntry.findMany({ where: { id: { in: ids } }, include: { lines: { select: { debit: true } } } })`; `page` runs the existing `findMany`(with the same `include`/`orderBy: [{date:'desc'},{entryNumber:'desc'}]`) + `count`. Pass `limit: filter.limit, offset: filter.offset`.

> **Watch-point:** journal's current code passes `filter.limit`/`filter.offset` straight through with no `?? 50`/`?? 0`. `listPaginated` defaults them to `DEFAULT_PAGE_SIZE`/`0`. Confirm the journal list query DTO already supplies `limit`/`offset` (it should — the journal list is enveloped). If a journal e2e expects an unbounded list when `limit` is omitted, that is the one behavior the seam changes; the e2e gate will flag it — if so, the new default (50) is the intended unified behavior, update that test's expectation.

- `deleteDraft()` (94): `return this.lifecycle.softDeleteDraft(this.prisma.client.journalEntry, id, deletedBy, 'entry');` — inject `DocumentLifecycleService` into `journal.service.ts` (constructor currently has `prisma`, `posting`, `accounts`).

- [ ] **Step 1: Apply the edits.**
- [ ] **Step 2: Typecheck + e2e + unit**

Run: `npm run db:generate && npm run typecheck && npm test`
Then: `npm run test:e2e -- journal`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add src/ledger/journal/journal.service.ts src/ledger/journal/journal.module.ts
git commit -m "refactor(ledger): migrate journal list/deleteDraft onto shared seams"
```

---

### Task 13: Migrate `business-partners.service.ts` `listPage`

**Files:** Modify `src/invoicing/business-partners.service.ts`.

- `listPage(q)` (74-116): `listPaginated` call with an identity presenter (`present: (r) => r`), `table: 'business_partners'`, `ownColumns: ['name', 'code', 'npwp', 'email']`, `filters: []`, `hydrate` = `findMany({ where: { id: { in: ids } } })`, `page` = `findMany({ orderBy: { code: 'asc' }, take, skip })` + `count()` (no `where`).

- [ ] **Step 1: Apply the edit.**
- [ ] **Step 2: Typecheck + e2e + unit**

Run: `npm run db:generate && npm run typecheck && npm test`
Then: `npm run test:e2e -- business-partners`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add src/invoicing/business-partners.service.ts
git commit -m "refactor(invoicing): migrate business-partners list onto listPaginated"
```

---

### Task 14: Swap 14 controller sites to `@IdempotentWrite()` + collapse list-query DTO

**Files:**
- Modify (decorator swap): `src/ledger/journal/journal.controller.ts` (3), `src/ledger/journal/opening-balances.controller.ts` (1), `src/close/closing.controller.ts` (1), `src/invoicing/sales-invoices.controller.ts` (3), `src/invoicing/payments.controller.ts` (3), `src/invoicing/purchase-bills.controller.ts` (3)
- Create: `src/invoicing/dto/document-list-query.dto.ts`
- Modify: `src/invoicing/dto/list-sales-invoices.dto.ts`, `src/invoicing/dto/list-purchase-bills.dto.ts` (collapse to the shared one)

- [ ] **Step 1: Swap each `@ApiHeader({...}) @Idempotent()` pair for `@IdempotentWrite()`**

At all 14 sites, delete the 5-line `@ApiHeader({ name: 'Idempotency-Key', ... })` block and the `@Idempotent()` line directly above the `@Post(...)`, and put a single `@IdempotentWrite()` in their place. Remove the now-unused `Idempotent` import in each controller; remove `ApiHeader` from the `@nestjs/swagger` import **only if** it is unused elsewhere in that file (grep the file for other `@ApiHeader(` first). Add `import { IdempotentWrite } from '<relative>/common/idempotency/idempotent-write.decorator';` (depth: `'../../common/...'` in `src/ledger/journal/*`; `'../common/...'` in `src/close/*` and `src/invoicing/*`).

- [ ] **Step 2: Collapse the duplicate list-query DTO**

`SalesInvoiceListQueryDto` and `PurchaseBillListQueryDto` are byte-identical except the name. Create:

```ts
// src/invoicing/dto/document-list-query.dto.ts
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { DocumentStatus } from '@prisma/client';
import { SearchQueryDto } from '../../common/dto/search-query.dto';

/** Shared list query for sales invoices & purchase bills (q + pagination + partner/status filters). */
export class DocumentListQueryDto extends SearchQueryDto {
  @IsOptional() @IsUUID() partnerId?: string;
  @IsOptional() @IsEnum(DocumentStatus) status?: DocumentStatus;
}
```

Update `sales-invoices.controller.ts` and `purchase-bills.controller.ts` to import and type their `@Get()` `@Query()` param as `DocumentListQueryDto`. Delete `list-sales-invoices.dto.ts` and `list-purchase-bills.dto.ts` (and update any other importers — grep `SalesInvoiceListQueryDto`/`PurchaseBillListQueryDto`).

- [ ] **Step 3: Typecheck + lint + full e2e**

Run: `npm run db:generate && npm run typecheck && npm run lint:ci && npm test`
Then: `npm run test:e2e`
Expected: all green (decorator behavior is identical; the idempotency e2e still passes).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: adopt @IdempotentWrite (14 sites) + collapse duplicate list-query DTO"
```

---

## Phase 3 — The deliberate breaking change

### Task 15: Standardize `accounts` + `tax-codes` lists onto the envelope

**Files:**
- Modify: `src/ledger/accounts/accounts.service.ts` (`list`), `src/ledger/accounts/accounts.controller.ts` (`@Get`)
- Modify: `src/tax/tax-codes.service.ts` (`list` at 117-122), `src/tax/tax-codes.controller.ts` (`@Get`)
- Create: `src/ledger/accounts/dto/account-list-response.dto.ts`, `src/tax/dto/tax-code-list-response.dto.ts` (or via the `PaginatedDto` factory from Task 16)
- Modify: `test/accounts.e2e-spec.ts`, `test/tax-codes.e2e-spec.ts` (expect the envelope)

- [ ] **Step 1: Write/adjust the failing e2e expectation first**

In `test/accounts.e2e-spec.ts`, change the list assertion from a bare array to the envelope, e.g.:
```ts
const res = await request(app.getHttpServer() as App)
  .get('/v1/accounts')
  .set('Authorization', `Bearer ${adminToken}`)
  .expect(200);
expect(res.body).toMatchObject({ total: expect.any(Number), limit: expect.any(Number), offset: 0 });
expect(Array.isArray(res.body.data)).toBe(true);
```
Do the same in `test/tax-codes.e2e-spec.ts` for `/v1/tax-codes`.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:e2e -- "accounts|tax-codes"`
Expected: FAIL (service still returns a bare array).

- [ ] **Step 3: Paginate the services**

Accounts and tax-codes are excluded from fuzzy search (per the fuzzy-search design), so they accept `PaginationQueryDto` (no `q`) and omit the optional `search`/`hydrate` — `listPaginated` then always takes the page branch.

```ts
// accounts.service.ts
async list(q: { limit?: number; offset?: number }) {
  return listPaginated({
    limit: q.limit,
    offset: q.offset,
    present: (r: Account) => r,
    page: async ({ limit, offset }) => {
      const [rows, total] = await Promise.all([
        this.prisma.client.account.findMany({ orderBy: { code: 'asc' }, take: limit, skip: offset }),
        this.prisma.client.account.count(),
      ]);
      return { rows, total };
    },
  });
}
```
`tax-codes.service.ts` `list` (117-122) — same shape with `this.prisma.client.taxCode`, `orderBy: { code: 'asc' }`, **and drop the redundant `where: { deletedAt: null }`** (the soft-delete extension injects it on the `count` and `findMany` — this also closes dead-code item 1e).

- [ ] **Step 4: Update the controllers**

```ts
// accounts.controller.ts
@Get()
@ApiOkResponse({ type: AccountListResponseDto })
list(@Query() q: PaginationQueryDto) {
  return this.accounts.list(q);
}
```
Create `AccountListResponseDto` (data: `AccountResponseDto[]` + total/limit/offset) — or use `PaginatedDto(AccountResponseDto)` from Task 16. Same for tax-codes with `PaginationQueryDto` + `TaxCodeListResponseDto`.

- [ ] **Step 5: Run the accounts/tax-codes e2e to verify green**

Run: `npm run test:e2e -- "accounts|tax-codes"`
Expected: PASS.

- [ ] **Step 6: Regenerate OpenAPI + update the contract guard**

Run: `npm run openapi:export`
Then update `src/common/openapi/openapi-contract.spec.ts` expectations for the two changed list responses, and update the bare-array note in `docs/api/frontend-guide.md`.
Run: `npm test` (the contract spec must pass).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat!: standardize accounts/tax-codes lists onto the paginated envelope

BREAKING CHANGE: GET /v1/accounts and GET /v1/tax-codes now return
{data,total,limit,offset} instead of a bare array. Frontend (accounting-client)
must unwrap .data. OpenAPI regenerated; frontend-guide updated."
```

> **Coordination follow-up (out of this repo):** the sibling `accounting-client` must unwrap `.data` for these two endpoints. Record this as a tracked task; do not consider the feature shipped until that is noted to the user.

---

## Phase 4 — Dead code + remaining nits

### Task 16: Consolidate response DTOs (shared base + `PaginatedDto` factory)

**Files:**
- Create: `src/common/openapi/paginated-dto.ts`
- Create: `src/invoicing/dto/transactional-document-response.dto.ts` (shared base)
- Modify: `src/invoicing/dto/sales-invoice-response.dto.ts`, `purchase-bill-response.dto.ts` (extend base; envelopes via factory)
- Modify: `src/common/openapi/openapi-contract.spec.ts` if schema names change; regenerate OpenAPI

- [ ] **Step 1: Add the `PaginatedDto` factory**

```ts
// src/common/openapi/paginated-dto.ts
import { Type } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Builds a named paginated-envelope class for OpenAPI. Pass `schemaName` to
 * preserve an existing schema name (avoids renaming already-published schemas);
 * defaults to `Paginated<Model>` for genuinely new endpoints.
 */
export function PaginatedDto<TModel extends Type<unknown>>(model: TModel, schemaName?: string) {
  class PaginatedResponseDto {
    @ApiProperty({ type: [model] }) data!: InstanceType<TModel>[];
    @ApiProperty({ example: 240 }) total!: number;
    @ApiProperty({ example: 50 }) limit!: number;
    @ApiProperty({ example: 0 }) offset!: number;
  }
  Object.defineProperty(PaginatedResponseDto, 'name', { value: schemaName ?? `Paginated${model.name}` });
  return PaginatedResponseDto;
}
```

> **Contract preservation:** at the 5 existing envelope sites, pass the current schema name verbatim (e.g. `PaginatedDto(SalesInvoiceResponseDto, 'SalesInvoiceListResponseDto')`) so the regenerated OpenAPI is byte-identical for those schemas — the dedup is internal-only. Only the new accounts/tax-codes envelopes (Task 15) introduce new schema names.

- [ ] **Step 2: Extract the shared base response DTO**

Create `TransactionalDocumentResponseDto` with the ~18 fields shared by sales & purchase (partnerId, date, dueDate, description, status, subtotal, taxTotal, withholdingTotal, total, amountPaid, journalEntryId, createdBy, postedBy, postedAt, createdAt, updatedAt, outstanding, paymentStatus, fiscalYear, id). Then:
- `SalesInvoiceResponseDto extends TransactionalDocumentResponseDto` adding `invoiceNumber`, `invoiceRef`, `lines?`.
- `PurchaseBillResponseDto extends TransactionalDocumentResponseDto` adding `billNumber`, `billRef`, `vendorInvoiceNo`, `lines?`.
Keep the `@ApiMoney`/`@ApiProperty` decorators on the base fields (Swagger flattens inherited properties, so the emitted field set is unchanged). Replace the five hand-written `*ListResponseDto` with `PaginatedDto(<Model>ResponseDto)` at the `@ApiOkResponse({ type: ... })` call sites.

- [ ] **Step 3: Regenerate OpenAPI + reconcile the contract spec**

Run: `npm run openapi:export && npm test`
Because the factory preserves the existing schema names (Step 1) and inherited `@ApiProperty` fields flatten unchanged, the regenerated `openapi.json` should be byte-identical for the 5 existing list/response schemas — `openapi-contract.spec.ts` should pass without edits. If `git diff docs/api/openapi.json` shows any change to those schemas, reconcile it (the goal is no diff for them). Expected: contract spec green.

- [ ] **Step 4: Typecheck + full e2e**

Run: `npm run db:generate && npm run typecheck && npm run test:e2e`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(invoicing): shared response-DTO base + PaginatedDto factory"
```

---

### Task 17: Delete the 7 dead-code items + remaining nits

**Files:**
- `src/common/money/money.ts` (remove `lessThan`, 56-58)
- `src/users/users.service.ts` (remove `findByEmail`, 64-67) + `test/users.e2e-spec.ts:61` (rewrite assertion)
- `src/ledger/balances/balances.service.ts` (remove `parentId` from `AccountBalanceRow:30`, raw field `:44`, SELECT `a.parent_id` `:72-73`, GROUP BY `:80`, map `:97`)
- `src/reporting/income-statement.service.ts` + `balance-sheet.service.ts` (one shared `ReportLine`)
- `src/audit/audit.interceptor.ts:14` + `src/audit/dto/audit-query.dto.ts:15` (shared `MUTATING_METHODS`)
- `src/common/search/trigram-search.ts` (make `buildTrigramIdQuery`/`buildTrigramCountQuery`/`SIMILARITY_THRESHOLD` internal — drop `export`; update `trigram-search.spec.ts` to import via a test-only path or test through `trigramSearch`)
- `src/reporting/reports.controller.ts:26-32` (consistent `…Svc` naming)
- `src/common/prisma/soft-delete.extension.ts:64,71,93,100` (extract `injectDeletedAtSelect(args)` helper)

- [ ] **Step 1: Remove `Money.lessThan()`**

Delete lines 56-58. (grep confirmed zero callers; `money.spec.ts` does not test it.)

- [ ] **Step 2: Remove `UsersService.findByEmail()` and fix its only caller**

Delete the method (64-67). In `test/users.e2e-spec.ts:61`, replace `expect(await users.findByEmail('del@example.com')).toBeNull();` with a direct check:
```ts
expect(await users.findByEmailWithHash('del@example.com')).toBeNull();
```
(verify `findByEmailWithHash` also filters soft-deleted — it does, via the extension).

- [ ] **Step 3: Remove `AccountBalanceRow.parentId`**

In `balances.service.ts`: delete the `parentId` interface field (30), the raw `parent_id` field (44), remove `a.parent_id` from the SELECT (72-73) and the `GROUP BY` (80), and the `parentId: r.parent_id` map line (97). (Confirmed no downstream consumer reads it.)

- [ ] **Step 4: Share `ReportLine`**

Move the `ReportLine` interface to a single home (e.g. `src/reporting/report-line.ts` or keep it in `income-statement.service.ts` and import into `balance-sheet.service.ts`). Delete the duplicate definition; update imports (note `balance-sheet`'s `ReportGroup` references `ReportLine`).

- [ ] **Step 5: Share the mutating-methods constant**

Create `src/audit/mutating-methods.ts`: `export const MUTATING_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE'] as const;`. In `audit.interceptor.ts:14` use `new Set(MUTATING_METHODS)`; in `audit-query.dto.ts:15` feed the tuple to its `@IsIn`.

- [ ] **Step 6: Internalize the trigram test-only exports (candidate B)**

Drop `export` from `buildTrigramIdQuery`, `buildTrigramCountQuery`, `SIMILARITY_THRESHOLD`. In `trigram-search.spec.ts`, switch those assertions to exercise `trigramSearch` end-to-end, or keep them via a `// @internal`-style re-export only in the test. Keep `MIN_QUERY_LENGTH` exported (services use it).

- [ ] **Step 7: Fix reports-controller naming drift**

In `reports.controller.ts:26-32`, rename `aging`→`agingSvc` and `cashFlow`→`cashFlowSvc` (or drop the `Svc` suffix from all five — pick one). Update the method bodies that reference them.

- [ ] **Step 8: Contain the soft-delete select casts**

Add a private `injectDeletedAtSelect(args)` helper in `soft-delete.extension.ts` that does the `(args as { select?: Record<string, unknown> })` read + conditional write once; call it from both `findUnique` and `findUniqueOrThrow` (lines 64/71 and 93/100). Leave line 198's `ctx as unknown` cast as-is (different shape).

- [ ] **Step 9: Typecheck + lint + full suite**

Run: `npm run db:generate && npm run typecheck && npm run lint:ci && npm test && npm run test:e2e`
Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: remove dead code + batch quality nits (ReportLine, MUTATING_METHODS, naming, soft-delete casts)"
```

---

## Phase 5 — Final verification

### Task 18: Full gate + OpenAPI export + casts sweep

- [ ] **Step 1: Grep for any remaining `as unknown as` money casts in presenters**

Run: `grep -rn "as unknown as" src/invoicing src/ledger src/reporting`
Expected: the 11 `present()` casts are gone. If any remain (audit cited 12 — one may live outside the three `present()`), route it through `serializeMoney` or `Money.toPersistence()`.

- [ ] **Step 2: Replace remaining raw `.toFixed(4)` in balances/general-ledger (nit #9)**

In `balances.service.ts` (toRow 98-100, trialBalance 139-141/147-148, accountBalance 176-178) and `general-ledger.service.ts:54-55`, replace `r.debit.toFixed(4)` with `Money.of(r.debit.toString()).toPersistence()` (and likewise for each operand). Run the relevant e2e (`npm run test:e2e -- "balances|ledger|reports"`) — output strings are identical for valid decimals.

- [ ] **Step 3: Transform query-param coercions (nits #4, #6)**

- `journal.controller.ts:83` `q.post === 'true'`: add a `@Transform`-backed boolean to the journal list/query DTO (`@Transform(({value}) => value === 'true' || value === true)` on a `post?: boolean`) and use `q.post` directly.
- Inline `new Date(dto.date)` (`sales-invoices.controller.ts:68`, `journal.controller.ts:50,78`): add a reusable `@Transform(({value}) => value ? new Date(value) : undefined)` on the relevant DTO date fields so the controller passes `dto.date` (already a `Date`) through.
Run typecheck + the affected e2e.

- [ ] **Step 4: Run the full gate**

Run: `npm run verify`
Expected: typecheck → lint:ci → unit → e2e:cov all pass (counts ≥ the 80 unit + 198 e2e baseline; coverage thresholds met).

- [ ] **Step 5: Regenerate + commit the final OpenAPI artifact**

Run: `npm run openapi:export`
```bash
git add -A
git commit -m "chore: route remaining money through Money + DTO transforms; regenerate OpenAPI"
```

- [ ] **Step 6: Finish the branch**

Use the superpowers:finishing-a-development-branch skill to decide merge/PR. Note the unresolved coordination item (accounting-client `.data` unwrap for accounts/tax-codes) in the merge/PR description.

---

## Self-Review notes

- **Spec coverage:** every §3 item maps to a task — dead code (Task 17), `listPage` ×5 (Tasks 1,9-13), `present`/casts (Tasks 2,9-11,18-1), `void`/`deleteDraft` (Tasks 7,9-12), control-account/`taxableLines` (Tasks 6,9-11), `RawTx`/`buildRef`/`fiscalYear` (Tasks 6,8), UTC truncation (Tasks 4,8), `@Idempotent` ×14 (Tasks 3,14), twin DTOs + list-query DTO (Tasks 14,16), candidate A (Tasks 1,2,9-13), candidate B (Task 17-6), candidate E (Tasks 3,14), nits 1-10 (Tasks 2/16/17/18 + Task 15 for nit #5 + Task 5/9-11 for nit #3). Candidates C & D explicitly deferred.
- **Highest risk:** Task 7/9-11 `void()` consolidation (payments divergence) — gated by the void e2e suite; the plan instructs reading the originals and preserving behavior, adjusting the seam to match (never the reverse).
- **Known watch-point:** journal `list` default-limit behavior (Task 12) — the seam now defaults `limit` to 50; the e2e gate surfaces any divergence.
