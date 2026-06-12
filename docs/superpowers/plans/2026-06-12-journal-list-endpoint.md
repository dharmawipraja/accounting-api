# Journal-Entry List Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a paginated, filtered `GET /ledger/journal-entries` list (the journal register) — read-only, no ledger-math change.

**Architecture:** A `JournalListQueryDto` (validated filters + limit/offset), `JournalService.list()` (`findMany` + parallel `count`, both soft-delete-filtered, header items with a server-computed `totalDebit`), and a `@Get()` handler on the existing `JournalController`. Mirrors the invoicing list + audit pagination patterns. The 147 e2e suite is the regression net.

**Tech Stack:** NestJS 11, Prisma 7, class-validator, `Money`, Jest + testcontainers.

**Spec:** `docs/superpowers/specs/2026-06-12-journal-list-endpoint-design.md`

**Ground rules:** NOT on `main` — create branch `journal-list-endpoint` first. Docker running. `verify` = `typecheck && lint:ci && test && test:e2e:cov`. Read-only feature — do NOT touch create/post/reverse/delete. Never run `prisma format`.

## File structure
- `src/ledger/journal/dto/list-journal-entries.dto.ts` — the query DTO (new).
- `src/ledger/journal/journal.service.ts` — add `JournalEntryListItem`, `list()`, `present()`.
- `src/ledger/journal/journal.controller.ts` — add the `@Get()` handler.
- `test/journal-list.e2e-spec.ts` — e2e (new).

---

## Task 1: Journal-entry list endpoint

**Files:** the four above.

- [ ] **Step 1: Branch**

```bash
git checkout -b journal-list-endpoint
```

- [ ] **Step 2: Write the failing e2e** `test/journal-list.e2e-spec.ts` (testcontainers; seed via the services). Mirror the bootstrap of an existing ledger e2e (Test module + ValidationPipe whitelist/forbidNonWhitelisted/transform + AllExceptionsFilter + makePrismaOverride + startTestDb):

```ts
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { CompanyService } from '../src/company/company.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { JournalService } from '../src/ledger/journal/journal.service';
import { UsersService } from '../src/users/users.service';
import { AuthService } from '../src/auth/auth.service';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Journal-entry list (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let token: string;
  let acc: Record<string, string>;

  const get = (url: string) =>
    request(app.getHttpServer() as App).get(url).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    db = await startTestDb();
    prisma = makePrismaOverride(db.url);
    await prisma.$connect();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService).useValue(prisma).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    await app.get(CompanyService).seedIfEmpty();
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const accounts = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    await app.get(UsersService).create({ email: 'jl@test.io', password: 'secret123', name: 'JL', role: 'VIEWER' });
    token = (await app.get(AuthService).login('jl@test.io', 'secret123')).accessToken;

    const posting = app.get(PostingService);
    const manual = (date: string, amt: string) => ({
      date: new Date(date), description: `Entry ${date}`, sourceType: 'MANUAL' as const, createdBy: 'a',
      lines: [{ accountId: acc['1-1000'], debit: amt }, { accountId: acc['3-1000'], credit: amt }],
    });
    await posting.post(manual('2026-02-10', '1000000'), 'p');
    await posting.post(manual('2026-03-15', '2000000'), 'p');
    // one DRAFT (not posted)
    await app.get(JournalService).createDraft({
      date: new Date('2026-02-20'), description: 'Draft entry', createdBy: 'a',
      lines: [{ accountId: acc['1-1000'], debit: '500000' }, { accountId: acc['3-1000'], credit: '500000' }],
    });
  }, 120_000);

  afterAll(async () => { await app.close(); await prisma.$disconnect(); await db?.stop(); });

  it('lists entries newest-first with header + totalDebit (4dp) + lineCount, no lines[]', async () => {
    const res = await get('/ledger/journal-entries').expect(200);
    const body = res.body as { data: any[]; total: number; limit: number; offset: number };
    expect(body.total).toBe(3); // 2 posted + 1 draft
    expect(body.data).toHaveLength(3);
    expect(body.data[0].date >= body.data[1].date).toBe(true); // date desc
    const item = body.data[0];
    expect(item).toHaveProperty('totalDebit');
    expect(item).toHaveProperty('lineCount', 2);
    expect(item).not.toHaveProperty('lines');
    expect(item.totalDebit).toMatch(/^\d+\.\d{4}$/); // 4dp string
  });

  it('filters by status=DRAFT (the approver "find pending drafts" case)', async () => {
    const res = await get('/ledger/journal-entries?status=DRAFT').expect(200);
    const body = res.body as { data: { status: string; description: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.data[0].status).toBe('DRAFT');
    expect(body.data[0].description).toBe('Draft entry');
  });

  it('filters by sourceType, date range, and fiscalYear', async () => {
    expect(((await get('/ledger/journal-entries?sourceType=MANUAL').expect(200)).body as { total: number }).total).toBe(3);
    const march = (await get('/ledger/journal-entries?from=2026-03-01&to=2026-03-31').expect(200)).body as { data: { date: string }[]; total: number };
    expect(march.total).toBe(1);
    expect(march.data[0].date).toBe('2026-03-15');
    expect(((await get('/ledger/journal-entries?fiscalYear=2026').expect(200)).body as { total: number }).total).toBe(2); // only POSTED entries carry fiscalYear; drafts have null
  });

  it('paginates with limit/offset (total reflects the full set)', async () => {
    const res = await get('/ledger/journal-entries?limit=1').expect(200);
    const body = res.body as { data: unknown[]; total: number; limit: number };
    expect(body.data).toHaveLength(1);
    expect(body.total).toBe(3);
    expect(body.limit).toBe(1);
  });

  it('rejects bad filter values with 400', async () => {
    await get('/ledger/journal-entries?status=GARBAGE').expect(400);
    await get('/ledger/journal-entries?fiscalYear=abc').expect(400);
  });
});
```
Run: `npm run test:e2e -- journal-list` → FAIL (no list route → the `GET /ledger/journal-entries` matches nothing or the `:id` route with id='journal-entries'... it returns 400/404, not the list).

NOTE on the `fiscalYear=2026` assertion: a DRAFT entry has `fiscalYear = null` (it's assigned on post), so `?fiscalYear=2026` returns only the 2 POSTED entries → `total` 2. If the seed/behavior differs, adjust the expected count to the actual posted-entry count.

- [ ] **Step 3: Create the DTO** `src/ledger/journal/dto/list-journal-entries.dto.ts`:

```ts
import { IsDateString, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { JournalStatus, JournalSourceType } from '@prisma/client';

export class JournalListQueryDto {
  @IsOptional() @IsEnum(JournalStatus) status?: JournalStatus;
  @IsOptional() @IsEnum(JournalSourceType) sourceType?: JournalSourceType;
  @IsOptional() @Type(() => Number) @IsInt() @Min(2000) @Max(2100) fiscalYear?: number;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
```

- [ ] **Step 4: Add `list()` + `present()` to `JournalService`** (`src/ledger/journal/journal.service.ts`). Extend the `@prisma/client` import to include `JournalStatus, JournalSourceType` (alongside `JournalEntry, Prisma`). Add the interface + methods:

```ts
export interface JournalEntryListItem {
  id: string;
  entryRef: string | null;
  entryNumber: number | null;
  fiscalYear: number | null;
  date: string;
  description: string;
  status: JournalStatus;
  sourceType: JournalSourceType;
  sourceId: string | null;
  totalDebit: string;
  lineCount: number;
}

export interface JournalListFilter {
  status?: JournalStatus;
  sourceType?: JournalSourceType;
  fiscalYear?: number;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}
```

Methods on the class:

```ts
  async list(filter: JournalListFilter): Promise<{
    data: JournalEntryListItem[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const where: Prisma.JournalEntryWhereInput = {
      status: filter.status,
      sourceType: filter.sourceType,
      fiscalYear: filter.fiscalYear,
      date: filter.from || filter.to ? { gte: filter.from, lte: filter.to } : undefined,
    };
    const [rows, total] = await Promise.all([
      this.prisma.client.journalEntry.findMany({
        where,
        include: { lines: { select: { debit: true } } },
        orderBy: [{ date: 'desc' }, { entryNumber: 'desc' }],
        take: filter.limit,
        skip: filter.offset,
      }),
      this.prisma.client.journalEntry.count({ where }),
    ]);
    return { data: rows.map((r) => this.present(r)), total, limit: filter.limit, offset: filter.offset };
  }

  private present(
    e: JournalEntry & { lines: { debit: Prisma.Decimal }[] },
  ): JournalEntryListItem {
    const total = e.lines.reduce(
      (s, l) => s.add(Money.of(l.debit)),
      Money.zero(),
    );
    return {
      id: e.id,
      entryRef: e.entryRef,
      entryNumber: e.entryNumber,
      fiscalYear: e.fiscalYear,
      date: e.date.toISOString().slice(0, 10),
      description: e.description,
      status: e.status,
      sourceType: e.sourceType,
      sourceId: e.sourceId,
      totalDebit: total.toPersistence(),
      lineCount: e.lines.length,
    };
  }
```
(`Money` is already imported. `Money.of` accepts a `Prisma.Decimal` directly.)

- [ ] **Step 5: Add the controller `@Get()`** in `src/ledger/journal/journal.controller.ts` (add `import { JournalListQueryDto } from './dto/list-journal-entries.dto';`; `Query` is already imported). Place it ABOVE `@Get(':id')`:

```ts
  @Get()
  list(@Query() q: JournalListQueryDto) {
    return this.journal.list({
      status: q.status,
      sourceType: q.sourceType,
      fiscalYear: q.fiscalYear,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    });
  }
```
No `@Roles` (any-authenticated, like `GET /:id`).

- [ ] **Step 6: Run the e2e — expect PASS**

Run: `npm run test:e2e -- journal-list`
Expected: 5 pass (list shape + totalDebit 4dp + no lines; status=DRAFT; sourceType/date/fiscalYear filters; pagination; 400s). If the `fiscalYear=2026` count differs, reconcile against actual draft `fiscalYear` (null) — adjust the test's expected number, not the service.

- [ ] **Step 7: Full regression + commit**

```bash
npm run typecheck && npm run lint:ci && npm test && npm run test:e2e
# typecheck/lint clean; full suite green (148 e2e now)
git add src/ledger/journal/dto/list-journal-entries.dto.ts src/ledger/journal/journal.service.ts src/ledger/journal/journal.controller.ts test/journal-list.e2e-spec.ts
git commit -m "feat(ledger): GET /ledger/journal-entries list (filtered, paginated journal register)"
```

---

## Self-review (against the spec)

**Spec coverage:**
- §2 endpoint `GET /ledger/journal-entries`, any-auth → Step 5 ✓
- §3 JournalListQueryDto (status/sourceType/fiscalYear/from/to/limit/offset, validated) → Step 3 ✓
- §4 service list (findMany + count, soft-delete-filtered, all statuses, date filter) + present (headers + totalDebit + lineCount, lines dropped) → Step 4 ✓
- §5 envelope {data,total,limit,offset} → Step 4 ✓
- §6 controller @Get above :id, new Date() conversion, defaults 50/0 → Step 5 ✓
- §7 e2e (newest-first, totalDebit 4dp, no lines, DRAFT filter, sourceType/date/fy filters, pagination, 400s) → Step 2 ✓

**Placeholder scan:** none — full code in every step. The `fiscalYear=2026` expected-count note is a reconciliation instruction (drafts have null fiscalYear), not a TBD.

**Type consistency:** `JournalEntryListItem` / `JournalListFilter` / `JournalListQueryDto` names match across the DTO, service, controller, and e2e; `JournalStatus`/`JournalSourceType` imported from `@prisma/client` in both the DTO and the service; the `present()` input shape (`{ lines: { debit: Prisma.Decimal }[] }`) matches the `findMany` `include: { lines: { select: { debit: true } } }`; the response envelope `{ data, total, limit, offset }` is identical in the service return type and the e2e assertions.
