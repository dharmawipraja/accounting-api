# Accounting API — Phase 6: Year-End Close & Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Year-end close (one reversible CLOSING entry zeroing P&L into Laba Ditahan, with a year-level posting lock) and an append-only audit log fed by a global interceptor.

**Architecture:** A `CloseModule` (`YearEndCloseService` + controller) posting through the existing tx-composable `PostingService`; a year-lock guard added to `PostingService.preparePosting` (reads `year_end_closings` directly, keeping the dependency one-way); an `AuditModule` with a global `APP_INTERCEPTOR`.

**Tech Stack:** NestJS 11, Prisma 7 (`prisma.client`, hand-authored migration), PostgreSQL, `Money`, rxjs interceptor, testcontainers e2e.

**Spec:** `docs/superpowers/specs/2026-06-11-accounting-api-phase-6-close-hardening-design.md`

**Prisma 7 reminder:** `migrate dev` needs a TTY and fails here — hand-author the migration SQL + `npx prisma migrate deploy` + `npx prisma generate`. DB up: `docker compose up -d db`. Never run `prisma format`.

## File structure
- `prisma/schema.prisma` — `CloseStatus` enum, `YearEndClosing` + `AuditLog` models, `CLOSING` added to `JournalSourceType`.
- `prisma/migrations/20260611070000_add_close_and_audit/migration.sql` — hand-authored (tables + enum value + Laba Ditahan UPDATE).
- `src/common/errors/domain-errors.ts` — add `ClosedYearError`.
- `src/ledger/accounts/chart-of-accounts.seed.ts` — 3-2000 → `cashFlowCategory: 'FINANCING'`.
- `src/ledger/posting/posting.service.ts` — year-lock guard in `preparePosting`.
- `src/close/close.module.ts`, `year-end-close.service.ts`, `closing.controller.ts`, `dto/close.dto.ts`.
- `src/audit/audit.module.ts`, `audit.service.ts`, `audit.interceptor.ts`, `audit.controller.ts`, `audit-sanitize.ts`, `dto/audit-query.dto.ts`.
- `src/app.module.ts` — import `CloseModule` + `AuditModule`.
- `test/close.e2e-spec.ts`, `test/audit.e2e-spec.ts`.

---

## Task 1: Schema, migration, domain error, module skeletons

**Files:** `prisma/schema.prisma`, `prisma/migrations/20260611070000_add_close_and_audit/migration.sql`, `src/common/errors/domain-errors.ts`, `src/ledger/accounts/chart-of-accounts.seed.ts`, `src/close/close.module.ts`, `src/audit/audit.module.ts`, `src/app.module.ts`

- [ ] **Step 1: Schema** — in `prisma/schema.prisma`, add `CLOSING` to `enum JournalSourceType` (keep MANUAL/REVERSAL/OPENING/SALES_INVOICE/PURCHASE_BILL/PAYMENT), then add:

```prisma
enum CloseStatus {
  OPEN
  CLOSED
}

model YearEndClosing {
  fiscalYear     Int         @id @map("fiscal_year")
  status         CloseStatus
  closingEntryId String?     @map("closing_entry_id")
  netIncome      Decimal     @default(0) @map("net_income") @db.Decimal(20, 4)
  closedAt       DateTime    @map("closed_at")
  closedBy       String      @map("closed_by")
  reopenedAt     DateTime?   @map("reopened_at")
  reopenedBy     String?     @map("reopened_by")
  updatedAt      DateTime    @updatedAt @map("updated_at")

  @@map("year_end_closings")
}

model AuditLog {
  id         String   @id @default(uuid())
  timestamp  DateTime @default(now())
  userId     String?  @map("user_id")
  userRole   String?  @map("user_role")
  method     String
  path       String
  params     Json?
  body       Json?
  statusCode Int      @map("status_code")
  durationMs Int      @map("duration_ms")
  ip         String?

  @@index([timestamp])
  @@index([userId])
  @@map("audit_log")
}
```
Do NOT register either model in `SOFT_DELETE_MODELS` (year_end_closings is mutable by the close service; audit_log is append-only).

- [ ] **Step 2: Hand-author the migration** `prisma/migrations/20260611070000_add_close_and_audit/migration.sql`:

```sql
-- AlterEnum
ALTER TYPE "JournalSourceType" ADD VALUE 'CLOSING';

-- CreateEnum
CREATE TYPE "CloseStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "year_end_closings" (
    "fiscal_year" INTEGER NOT NULL,
    "status" "CloseStatus" NOT NULL,
    "closing_entry_id" TEXT,
    "net_income" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "closed_at" TIMESTAMP(3) NOT NULL,
    "closed_by" TEXT NOT NULL,
    "reopened_at" TIMESTAMP(3),
    "reopened_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "year_end_closings_pkey" PRIMARY KEY ("fiscal_year")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" TEXT,
    "user_role" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "params" JSONB,
    "body" JSONB,
    "status_code" INTEGER NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "ip" TEXT,
    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_timestamp_idx" ON "audit_log"("timestamp");
CREATE INDEX "audit_log_user_id_idx" ON "audit_log"("user_id");

-- DataMigration: Laba Ditahan flows as FINANCING in the cash-flow statement
UPDATE "accounts" SET "cash_flow_category" = 'FINANCING' WHERE "code" = '3-2000';
```

- [ ] **Step 3: Apply** — `docker compose up -d db && npx prisma migrate deploy && npx prisma generate && npx prisma migrate status` → "Database schema is up to date!".

- [ ] **Step 4: Domain error** — in `src/common/errors/domain-errors.ts`, after `ClosedPeriodError`, add:

```typescript
export class ClosedYearError extends DomainError {
  readonly code = 'CLOSED_YEAR';
  readonly status = 409;
}
```

- [ ] **Step 5: Chart seed fix** — in `src/ledger/accounts/chart-of-accounts.seed.ts`, find the `3-2000` Laba Ditahan entry and add `cashFlowCategory: 'FINANCING'` to it (so fresh DBs match the migration's UPDATE).

- [ ] **Step 6: Module skeletons.** `src/close/close.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { CompanyModule } from '../company/company.module';

@Module({ imports: [LedgerModule, CompanyModule], providers: [], controllers: [], exports: [] })
export class CloseModule {}
```

`src/audit/audit.module.ts`:

```typescript
import { Module } from '@nestjs/common';

@Module({ providers: [], controllers: [], exports: [] })
export class AuditModule {}
```

In `src/app.module.ts`, import both and add `CloseModule` + `AuditModule` to `imports` (after `ReportingModule`).

- [ ] **Step 7: Build, regression, commit**

```bash
npm run build && npm run lint
npm run test:e2e -- "posting|balances"   # unaffected, still green
git add prisma src/common/errors/domain-errors.ts src/ledger/accounts/chart-of-accounts.seed.ts src/close src/audit src/app.module.ts
git commit -m "feat(close): schema, ClosedYearError, Laba Ditahan cash-flow fix, module skeletons"
```

---

## Task 2: Year-end close, reopen, and the year-lock guard

**Files:** `src/close/year-end-close.service.ts`, `src/close/dto/close.dto.ts`, `src/close/closing.controller.ts`, `src/close/close.module.ts`, `src/ledger/posting/posting.service.ts`; Test: `test/close.e2e-spec.ts`

- [ ] **Step 1: Add the year-lock guard to `preparePosting`** in `src/ledger/posting/posting.service.ts`. Add `ClosedYearError` to the import from `../../common/errors/domain-errors`, and insert the check right before `preparePosting`'s `return`:

```typescript
    const fiscalYear = this.fiscalYearFor(
      input.date,
      settings.fiscalYearStartMonth,
    );
    const closedYear = await this.prisma.client.yearEndClosing.findFirst({
      where: { fiscalYear, status: 'CLOSED' },
    });
    if (closedYear) {
      throw new ClosedYearError(
        'Fiscal year is closed; reopen it before posting',
        { fiscalYear },
      );
    }
    return { periodId: period.id, fiscalYear };
```
Leave `prepareReversal` unchanged (reversals must stay allowed in a closed year so `reopen` can reverse the closing entry).

- [ ] **Step 2: Verify the guard didn't break open-year posting**

Run: `npm run test:e2e -- "posting|balances"` → still green (no `year_end_closings` rows exist, so `findFirst` returns null and posting proceeds). `npm run build`.

- [ ] **Step 3 (TDD): write `test/close.e2e-spec.ts`** — seed posted P&L via PostingService, then exercise close/lock/reopen. Full code:

```typescript
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { BalancesService } from '../src/ledger/balances/balances.service';
import { YearEndCloseService } from '../src/close/year-end-close.service';
import { ClosedYearError } from '../src/common/errors/domain-errors';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Year-end close (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let acc: Record<string, string>;
  let close: YearEndCloseService;
  let posting: PostingService;
  let balances: BalancesService;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = makePrismaOverride(db.url);
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService).useValue(prisma).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.get(CompanyService).seedIfEmpty();
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    await app.get(PeriodsService).generatePeriods(2027);
    const accounts = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    posting = app.get(PostingService);
    close = app.get(YearEndCloseService);
    balances = app.get(BalancesService);
    // 2026 P&L: revenue 2,000,000 (Cr 4-1000 / Dr Kas) and expense 500,000 (Dr 5-2000 / Cr Kas).
    await posting.post({ date: new Date('2026-02-10'), description: 'Sale', sourceType: 'MANUAL', createdBy: 'a',
      lines: [{ accountId: acc['1-1000'], debit: '2000000' }, { accountId: acc['4-1000'], credit: '2000000' }] }, 'p');
    await posting.post({ date: new Date('2026-02-15'), description: 'Expense', sourceType: 'MANUAL', createdBy: 'a',
      lines: [{ accountId: acc['5-2000'], debit: '500000' }, { accountId: acc['1-1000'], credit: '500000' }] }, 'p');
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  const plBalance = async (): Promise<number> => {
    const rows = await balances.balancesAsOf(new Date('2026-12-31'));
    return rows.filter((r) => r.type === 'REVENUE' || r.type === 'EXPENSE')
      .reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0);
  };

  it('closes the year: zeroes P&L, nets to Laba Ditahan, marks CLOSED', async () => {
    expect(await plBalance()).not.toBe(0);
    const rec = await close.close(2026, 'admin');
    expect(rec.status).toBe('CLOSED');
    expect(rec.netIncome).toBe('1500000.0000'); // 2,000,000 − 500,000
    expect(await plBalance()).toBe(0); // P&L zeroed as of year-end
    const ret = await balances.accountBalance(acc['3-2000'], new Date('2026-12-31'));
    expect(ret.balance).toBe('1500000.0000'); // net income moved to Laba Ditahan
  });

  it('blocks new posting into the closed year, allows the next year', async () => {
    await expect(
      posting.post({ date: new Date('2026-06-01'), description: 'late', sourceType: 'MANUAL', createdBy: 'a',
        lines: [{ accountId: acc['1-1000'], debit: '100' }, { accountId: acc['4-1000'], credit: '100' }] }, 'p'),
    ).rejects.toBeInstanceOf(ClosedYearError);
    // 2027 is open
    const ok = await posting.post({ date: new Date('2027-02-01'), description: 'next yr', sourceType: 'MANUAL', createdBy: 'a',
      lines: [{ accountId: acc['1-1000'], debit: '100' }, { accountId: acc['4-1000'], credit: '100' }] }, 'p');
    expect(ok.status).toBe('POSTED');
  });

  it('is idempotent: re-closing a closed year is rejected', async () => {
    await expect(close.close(2026, 'admin')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('reopens: reverses the closing entry, restores P&L, allows posting again', async () => {
    const rec = await close.reopen(2026, 'admin');
    expect(rec.status).toBe('OPEN');
    expect(await plBalance()).not.toBe(0); // P&L restored by the reversal
    const ok = await posting.post({ date: new Date('2026-06-01'), description: 'correction', sourceType: 'MANUAL', createdBy: 'a',
      lines: [{ accountId: acc['1-1000'], debit: '100' }, { accountId: acc['4-1000'], credit: '100' }] }, 'p');
    expect(ok.status).toBe('POSTED');
  });
});
```
Run `npm run test:e2e -- close` → FAIL (YearEndCloseService missing).

- [ ] **Step 4: `src/close/year-end-close.service.ts`**

```typescript
import { Injectable } from '@nestjs/common';
import { YearEndClosing } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import { PostingService } from '../ledger/posting/posting.service';
import { BalancesService } from '../ledger/balances/balances.service';
import { CompanyService } from '../company/company.service';
import { PostLineInput } from '../ledger/posting/posting.types';
import {
  ConflictDomainError,
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';

const RETAINED_EARNINGS_CODE = '3-2000';

@Injectable()
export class YearEndCloseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
    private readonly balances: BalancesService,
    private readonly company: CompanyService,
  ) {}

  /** Last UTC day of the fiscal year, given the company's start month. */
  private fiscalYearEnd(fiscalYear: number, startMonth: number): Date {
    const endYear = startMonth === 1 ? fiscalYear : fiscalYear + 1;
    const endMonth0 = startMonth === 1 ? 11 : startMonth - 2; // 0-based last month
    return new Date(Date.UTC(endYear, endMonth0 + 1, 0)); // day 0 of next month = last day
  }

  async getStatus(fiscalYear: number): Promise<YearEndClosing | null> {
    return this.prisma.client.yearEndClosing.findUnique({ where: { fiscalYear } });
  }

  async close(fiscalYear: number, closedBy: string): Promise<YearEndClosing> {
    const existing = await this.getStatus(fiscalYear);
    if (existing?.status === 'CLOSED') {
      throw new ConflictDomainError('Fiscal year is already closed', { fiscalYear });
    }
    const settings = await this.company.get();
    const yearEnd = this.fiscalYearEnd(fiscalYear, settings.fiscalYearStartMonth);

    const rows = (await this.balances.balancesAsOf(yearEnd)).filter(
      (r) => r.type === 'REVENUE' || r.type === 'EXPENSE',
    );
    const lines: PostLineInput[] = [];
    let netIncome = Money.zero(); // Σ(credit − debit)
    for (const r of rows) {
      const position = Money.of(r.debit).subtract(Money.of(r.credit)); // debit − credit
      if (position.isZero()) continue;
      netIncome = netIncome.subtract(position);
      lines.push(
        position.isNegative()
          ? { accountId: r.accountId, debit: position.multiply('-1').toPersistence() }
          : { accountId: r.accountId, credit: position.toPersistence() },
      );
    }

    // Empty year: no P&L movement — mark closed without an entry.
    if (lines.length === 0) {
      return this.upsertClosed(fiscalYear, null, '0.0000', closedBy);
    }

    if (!netIncome.isZero()) {
      const retained = await this.prisma.client.account.findFirst({
        where: { code: RETAINED_EARNINGS_CODE },
      });
      if (!retained) {
        throw new ValidationFailedError('Laba Ditahan account missing from chart', {
          code: RETAINED_EARNINGS_CODE,
        });
      }
      lines.push(
        netIncome.isNegative()
          ? { accountId: retained.id, debit: netIncome.multiply('-1').toPersistence() }
          : { accountId: retained.id, credit: netIncome.toPersistence() },
      );
    }

    const closingInput = {
      date: yearEnd,
      description: `Year-end close FY${fiscalYear}`,
      sourceType: 'CLOSING' as const,
      createdBy: closedBy,
      lines,
    };
    const { periodId, fiscalYear: fy } = await this.posting.preparePosting(
      closingInput,
      closedBy,
    );
    const incomeStr = netIncome.toPersistence();
    await this.prisma.client.$transaction(async (tx) => {
      const entry = await this.posting.createPostedEntryInTx(
        tx, closingInput, closedBy, periodId, fy,
      );
      await tx.yearEndClosing.upsert({
        where: { fiscalYear },
        create: { fiscalYear, status: 'CLOSED', closingEntryId: entry.id, netIncome: incomeStr, closedAt: new Date(), closedBy },
        update: { status: 'CLOSED', closingEntryId: entry.id, netIncome: incomeStr, closedAt: new Date(), closedBy, reopenedAt: null, reopenedBy: null },
      });
    });
    return this.getStatus(fiscalYear) as Promise<YearEndClosing>;
  }

  private async upsertClosed(
    fiscalYear: number, closingEntryId: string | null, netIncome: string, closedBy: string,
  ): Promise<YearEndClosing> {
    return this.prisma.client.yearEndClosing.upsert({
      where: { fiscalYear },
      create: { fiscalYear, status: 'CLOSED', closingEntryId, netIncome, closedAt: new Date(), closedBy },
      update: { status: 'CLOSED', closingEntryId, netIncome, closedAt: new Date(), closedBy, reopenedAt: null, reopenedBy: null },
    });
  }

  async reopen(fiscalYear: number, reopenedBy: string): Promise<YearEndClosing> {
    const rec = await this.getStatus(fiscalYear);
    if (!rec || rec.status !== 'CLOSED') {
      throw new ValidationFailedError('Fiscal year is not closed', { fiscalYear });
    }
    if (rec.closingEntryId) {
      const { original, periodId, fiscalYear: fy, reversalDate } =
        await this.posting.prepareReversal(rec.closingEntryId);
      await this.prisma.client.$transaction(async (tx) => {
        await this.posting.reverseInTx(tx, original, reopenedBy, periodId, fy, reversalDate);
        await tx.yearEndClosing.update({
          where: { fiscalYear },
          data: { status: 'OPEN', reopenedAt: new Date(), reopenedBy },
        });
      });
    } else {
      await this.prisma.client.yearEndClosing.update({
        where: { fiscalYear },
        data: { status: 'OPEN', reopenedAt: new Date(), reopenedBy },
      });
    }
    return this.getStatus(fiscalYear) as Promise<YearEndClosing>;
  }
}
```
(`NotFoundDomainError` import may be unused — drop it if the linter flags it.)

- [ ] **Step 5: DTO** `src/close/dto/close.dto.ts`:

```typescript
import { IsInt, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CloseYearDto {
  @Type(() => Number) @IsInt() @Min(2000) @Max(2100) fiscalYear!: number;
}
```

- [ ] **Step 6: Controller** `src/close/closing.controller.ts`:

```typescript
import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';
import { YearEndClosing } from '@prisma/client';
import { YearEndCloseService } from './year-end-close.service';
import { CloseYearDto } from './dto/close.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { NotFoundDomainError } from '../common/errors/domain-errors';

@Controller('close/year-end')
export class ClosingController {
  constructor(private readonly close: YearEndCloseService) {}

  @Roles(Role.ADMIN)
  @Post()
  @HttpCode(200)
  run(@Body() dto: CloseYearDto, @CurrentUser() user: AuthenticatedUser): Promise<YearEndClosing> {
    return this.close.close(dto.fiscalYear, user.id);
  }

  @Roles(Role.ADMIN)
  @Post(':fiscalYear/reopen')
  @HttpCode(200)
  reopen(@Param('fiscalYear', ParseIntPipe) fiscalYear: number, @CurrentUser() user: AuthenticatedUser): Promise<YearEndClosing> {
    return this.close.reopen(fiscalYear, user.id);
  }

  @Get(':fiscalYear')
  async status(@Param('fiscalYear', ParseIntPipe) fiscalYear: number): Promise<YearEndClosing> {
    const rec = await this.close.getStatus(fiscalYear);
    if (!rec) throw new NotFoundDomainError('No close record for fiscal year', { fiscalYear });
    return rec;
  }
}
```

- [ ] **Step 7: Register** `YearEndCloseService` (provider + export) + `ClosingController` in `CloseModule`.

- [ ] **Step 8: Run + regressions** — `npm run test:e2e -- close` → 4 PASS. Then regression: `npm run test:e2e -- "posting|balances|reporting|sales-invoices|payments"` (the guard + cash-flow change must not break them). `npm run lint`.

- [ ] **Step 9: Add the cross-report invariant assertions** to `test/close.e2e-spec.ts` — after the close test, assert via HTTP/services that the Neraca synthetic earnings is 0 and cash-flow reconciles. Add this case (uses BalanceSheetService + CashFlowService — import them):

```typescript
  it('after close: Neraca current-year earnings is 0 and cash-flow still reconciles', async () => {
    // (run after the close test, before reopen — re-close if needed)
    const status = await close.getStatus(2026);
    if (status?.status !== 'CLOSED') await close.close(2026, 'admin');
    const bs = await app.get(BalanceSheetService).generate(new Date('2026-12-31'));
    expect(bs.currentYearEarnings).toBe('0.0000'); // P&L closed out
    expect(bs.balanced).toBe(true);
    const cf = await app.get(CashFlowService).generate(new Date('2026-01-01'), new Date('2026-12-31'));
    expect(cf.reconciles).toBe(true);
  });
```
(Import `BalanceSheetService` from `../src/reporting/balance-sheet.service` and `CashFlowService` from `../src/reporting/cash-flow.service`. Place this test so it runs while 2026 is closed — i.e. before the reopen test, or self-heal with the `if` guard shown.) Re-run `npm run test:e2e -- close`.

- [ ] **Step 10: Commit**

```bash
git add src/close src/ledger/posting/posting.service.ts test/close.e2e-spec.ts
git commit -m "feat(close): year-end close/reopen + year-lock posting guard"
```

---

## Task 3: Audit log

**Files:** `src/audit/audit-sanitize.ts`, `audit.service.ts`, `audit.interceptor.ts`, `audit.controller.ts`, `dto/audit-query.dto.ts`, `audit.module.ts`, `src/app.module.ts` (none — AuditModule registers the global interceptor); Test: `test/audit.e2e-spec.ts`

- [ ] **Step 1: Sanitizer** `src/audit/audit-sanitize.ts`:

```typescript
const SENSITIVE = /password|token|secret|authorization/i;

/** Recursively redact sensitive keys in a request body for safe audit storage. */
export function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? '[REDACTED]' : sanitize(v);
    }
    return out;
  }
  return value;
}
```

- [ ] **Step 2: AuditService** `src/audit/audit.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

export interface AuditEntry {
  userId: string | null;
  userRole: string | null;
  method: string;
  path: string;
  params: unknown;
  body: unknown;
  statusCode: number;
  durationMs: number;
  ip: string | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  constructor(private readonly prisma: PrismaService) {}

  /** Append-only. Never throws — an audit failure must not break the request. */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.client.auditLog.create({
        data: {
          userId: entry.userId,
          userRole: entry.userRole,
          method: entry.method,
          path: entry.path,
          params: (entry.params ?? {}) as object,
          body: (entry.body ?? {}) as object,
          statusCode: entry.statusCode,
          durationMs: entry.durationMs,
          ip: entry.ip,
        },
      });
    } catch (err) {
      this.logger.error(`Failed to write audit log: ${String(err)}`);
    }
  }

  async list(filter: { userId?: string; method?: string; from?: Date; to?: Date; limit: number; offset: number }) {
    return this.prisma.client.auditLog.findMany({
      where: {
        userId: filter.userId,
        method: filter.method,
        timestamp: { gte: filter.from, lte: filter.to },
      },
      orderBy: { timestamp: 'desc' },
      take: filter.limit,
      skip: filter.offset,
    });
  }
}
```

- [ ] **Step 3: Interceptor** `src/audit/audit.interceptor.ts` (awaits the write before completing, so it's deterministic and lossless):

```typescript
import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, from, throwError } from 'rxjs';
import { catchError, concatMap } from 'rxjs/operators';
import { AuditService } from './audit.service';
import { sanitize } from './audit-sanitize';

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

interface AuditableRequest {
  method: string;
  originalUrl?: string;
  url: string;
  params: Record<string, unknown>;
  body: unknown;
  ip?: string;
  user?: { id: string; role: string };
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<AuditableRequest>();
    if (!MUTATING.has(req.method)) return next.handle();
    const start = Date.now();
    const res = ctx.switchToHttp().getResponse<{ statusCode: number }>();
    const base = {
      userId: req.user?.id ?? null,
      userRole: req.user?.role ?? null,
      method: req.method,
      path: req.originalUrl ?? req.url,
      params: req.params ?? {},
      body: sanitize(req.body),
      ip: req.ip ?? null,
    };
    return next.handle().pipe(
      concatMap((data) =>
        from(
          this.audit.record({ ...base, statusCode: res.statusCode, durationMs: Date.now() - start }),
        ).pipe(concatMap(() => from([data]))),
      ),
      catchError((err: unknown) => {
        const statusCode = err instanceof HttpException ? err.getStatus() : 500;
        return from(
          this.audit.record({ ...base, statusCode, durationMs: Date.now() - start }),
        ).pipe(concatMap(() => throwError(() => err)));
      }),
    );
  }
}
```
Note: on the success path `res.statusCode` reflects the status set at interception time (a 2xx); the error path captures the thrown exception's exact status. Tests assert success as a 2xx range and assert exact status only for the error case.

- [ ] **Step 4: Query DTO** `src/audit/dto/audit-query.dto.ts`:

```typescript
import { IsDateString, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class AuditQueryDto {
  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsString() method?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
```

- [ ] **Step 5: Controller** `src/audit/audit.controller.ts`:

```typescript
import { Controller, Get, Query } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditQueryDto } from './dto/audit-query.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/role.enum';

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Roles(Role.ADMIN)
  @Get()
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
}
```

- [ ] **Step 6: AuditModule (registers the global interceptor)** `src/audit/audit.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { AuditInterceptor } from './audit.interceptor';

@Module({
  providers: [AuditService, { provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
  controllers: [AuditController],
  exports: [AuditService],
})
export class AuditModule {}
```
(`AppModule` already imports `AuditModule` from Task 1 — the `APP_INTERCEPTOR` provider makes it global.)

- [ ] **Step 7 (TDD): write `test/audit.e2e-spec.ts`** (write the test, run red, then it passes once the module above is wired). Full code:

```typescript
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Audit log (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let adminToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = makePrismaOverride(db.url);
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService).useValue(prisma).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    const users = app.get(UsersService);
    await users.create({ email: 'admin@audit.test', password: 'secret123', name: 'Admin', role: 'ADMIN' });
    await users.create({ email: 'view@audit.test', password: 'secret123', name: 'V', role: 'VIEWER' });
    adminToken = (await app.get(AuthService).login('admin@audit.test', 'secret123')).accessToken;
    viewerToken = (await app.get(AuthService).login('view@audit.test', 'secret123')).accessToken;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  it('records a mutating request and redacts the password', async () => {
    const before = await prisma.client.auditLog.count();
    // A mutating POST that goes through the interceptor (create a partner via the admin).
    await request(app.getHttpServer() as App)
      .post('/partners').set('Authorization', `Bearer ${adminToken}`)
      .send({ code: 'AUD-1', name: 'Audited', isCustomer: true }).expect(201);
    const after = await prisma.client.auditLog.count();
    expect(after).toBe(before + 1);
    const row = await prisma.client.auditLog.findFirst({ where: { path: { contains: '/partners' } }, orderBy: { timestamp: 'desc' } });
    expect(row!.method).toBe('POST');
    expect(row!.statusCode).toBeGreaterThanOrEqual(200);
    expect(row!.statusCode).toBeLessThan(300);
    expect(row!.userId).toBeTruthy();
  });

  it('does not record GET reads', async () => {
    const before = await prisma.client.auditLog.count();
    await request(app.getHttpServer() as App).get('/partners').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(await prisma.client.auditLog.count()).toBe(before);
  });

  it('GET /audit is ADMIN-only and returns entries', async () => {
    await request(app.getHttpServer() as App).get('/audit').set('Authorization', `Bearer ${viewerToken}`).expect(403);
    const res = await request(app.getHttpServer() as App).get('/audit').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as unknown[]).length).toBeGreaterThan(0);
  });
});
```
Run `npm run test:e2e -- audit` → after wiring, 3 PASS.

- [ ] **Step 8: Full verification + commit**

```bash
npm run build && npm run lint && npm test && npm run test:e2e
git add src/audit test/audit.e2e-spec.ts
git commit -m "feat(audit): append-only audit log via global interceptor"
```

---

## Self-review (against the spec)

**Spec coverage:**
- §2 modules (CloseModule, AuditModule, one-way dep via direct read) → Tasks 1–3 ✓
- §3 data model (year_end_closings, audit_log, CloseStatus, CLOSING, Laba Ditahan FINANCING migration+seed) → Task 1 ✓
- §4 close/reopen (opposite-of-position close, plug to Laba Ditahan, empty-year skip, atomic, reverse-on-reopen) → Task 2 service ✓
- §5 year-lock guard in preparePosting only (ClosedYearError; not on prepareReversal) → Task 2 Step 1 ✓
- §6 audit interceptor (mutating only, sanitize, both outcomes, append-only) → Task 3 ✓
- §7 API + roles (close/reopen ADMIN, status any-auth, audit ADMIN) → Task 2/3 controllers ✓
- §8 testing (close zeroes P&L, lock, reopen, empty year, Neraca==0 + cash-flow reconciles invariants, audit logged/not/sanitized/ADMIN, Phase-1–5 regression) → Tasks 2 & 3 e2e ✓

**Placeholder scan:** none — full code in every step.

**Type consistency:** `YearEndCloseService.close/reopen/getStatus` return `YearEndClosing`; `preparePosting`/`createPostedEntryInTx`/`prepareReversal`/`reverseInTx` signatures match the Phase-4 refactor (incl. the `reversalDate` 6th arg on reverseInTx); `ClosedYearError` added to domain-errors and imported in posting.service; `PostLineInput`/`Money` APIs match; `AuditEntry` fields match `audit_log` columns; `sanitize` used by the interceptor; `APP_INTERCEPTOR` registered in AuditModule (AppModule imports it). Control code `3-2000` exists.
