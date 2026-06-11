# Accounting API — Phase 5: Financial Reporting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five read-only financial reports — Neraca, Laba Rugi, Buku Besar, AR/AP aging, Arus Kas — as structured-JSON endpoints over the posted ledger + AR/AP subledger, with built-in integrity checks.

**Architecture:** A read-only `ReportingModule` (`src/reporting/`) with one service per report, composing two new `BalancesService` grouped primitives (`balancesAsOf`/`movementsBetween`) plus subledger raw SQL. No new tables, no migration.

**Tech Stack:** NestJS 11, Prisma 7 (`$queryRaw` / `Prisma.sql`), PostgreSQL, `Money`, class-validator query DTOs, testcontainers e2e.

**Spec:** `docs/superpowers/specs/2026-06-11-accounting-api-phase-5-reporting-design.md`

**No migration** — reporting adds no tables. DB up: `docker compose up -d db`.

## CRITICAL sign conventions (every report follows these)

`balancesAsOf`/`movementsBetween` return per-account **raw** `debit`/`credit` sums + metadata. Reports compute amounts by **account type**, NOT by the `normalBalance`-signed balance (so contra accounts — e.g. Akumulasi Penyusutan, a CREDIT-normal account inside ASSET — net correctly):

- **Balance sheet line amount:** `ASSET` → `debit − credit`; `LIABILITY`/`EQUITY` → `credit − debit`. (A contra-asset nets negative within assets.)
- **Income statement line magnitude:** `REVENUE`/`OTHER_INCOME` (credit-side) → `credit − debit`; `COGS`/`OPERATING_EXPENSE`/`OTHER_EXPENSE` (debit-side) → `debit − credit`.
- **Net income / synthetic earnings:** `Σ (credit − debit)` over all `REVENUE`+`EXPENSE` rows (revenue is credit-heavy → positive, expense debit-heavy → negative).
- **Cash-flow cash-effect:** `credit − debit` (uniform); cash accounts use `debit − credit`.

---

## File structure
- `src/ledger/balances/balances.service.ts` — add `AccountBalanceRow`, `balancesAsOf`, `movementsBetween`, private `groupedBalances`; refactor `trialBalance` to reuse it.
- `src/reporting/reporting.module.ts`, `src/reporting/reports.controller.ts`.
- `src/reporting/balance-sheet.service.ts`, `income-statement.service.ts`, `general-ledger.service.ts`, `aging.service.ts`, `cash-flow.service.ts`.
- `src/reporting/dto/report-query.dto.ts` (as-of + range query DTOs).
- `src/app.module.ts` — register `ReportingModule`.
- `test/reporting-*.e2e-spec.ts`.

---

## Task 1: BalancesService grouped primitives + ReportingModule skeleton

**Files:** `src/ledger/balances/balances.service.ts`, `src/reporting/reporting.module.ts`, `src/app.module.ts`; Test: `test/balances.e2e-spec.ts` (extend)

- [ ] **Step 1: Write the failing test** — extend `test/balances.e2e-spec.ts` with primitives coverage. Add inside the existing `describe` (it already seeds accounts/periods + posts entries; `prisma`, `app`, `kasId`, `modalId` are in scope; import `BalancesService`):

```typescript
  it('balancesAsOf returns per-account rows with metadata (Kas debit-side)', async () => {
    const rows = await app.get(BalancesService).balancesAsOf(new Date('2026-12-31'));
    const kas = rows.find((r) => r.code === '1-1000');
    expect(kas).toBeDefined();
    expect(kas!.type).toBe('ASSET');
    expect(Number(kas!.debit)).toBeGreaterThan(0);
    // every posted account present; totals tie (Σ debit == Σ credit)
    const td = rows.reduce((s, r) => s + Number(r.debit), 0);
    const tc = rows.reduce((s, r) => s + Number(r.credit), 0);
    expect(td).toBeCloseTo(tc, 4);
  });

  it('movementsBetween sums only entries dated in the range', async () => {
    const all = await app.get(BalancesService).movementsBetween(new Date('2026-01-01'), new Date('2026-12-31'));
    const none = await app.get(BalancesService).movementsBetween(new Date('2027-01-01'), new Date('2027-12-31'));
    expect(all.length).toBeGreaterThan(0);
    expect(none.length).toBe(0);
  });
```
Run `npm run test:e2e -- balances` → FAIL (methods missing).

- [ ] **Step 2: Add the row type + primitives, refactor `trialBalance`** in `src/ledger/balances/balances.service.ts`.

Add the import for `Prisma` is already present. Add the interface (next to `TrialBalanceRow`):

```typescript
export interface AccountBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  normalBalance: string;
  cashFlowCategory: string;
  parentId: string | null;
  debit: string; // raw summed debits, 4dp
  credit: string; // raw summed credits, 4dp
  balance: string; // normalBalance-signed net, 4dp (convenience)
}

interface RawBalanceRow {
  account_id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  normal_balance: string;
  cash_flow_category: string;
  parent_id: string | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
}
```

Add the private builder + two primitives (and a mapper):

```typescript
  /** Grouped per-account debit/credit sums + metadata over a date predicate.
   *  Single source of the posted_at/soft-delete rules (shared with trialBalance). */
  private async groupedBalances(dateFilter: Prisma.Sql): Promise<RawBalanceRow[]> {
    return this.prisma.$queryRaw<RawBalanceRow[]>(Prisma.sql`
      SELECT a.id AS account_id, a.code, a.name, a.type, a.subtype,
             a.normal_balance, a.cash_flow_category, a.parent_id,
             COALESCE(SUM(jl.debit), 0) AS debit,
             COALESCE(SUM(jl.credit), 0) AS credit
      FROM accounts a
      JOIN journal_lines jl ON jl.account_id = a.id
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.posted_at IS NOT NULL AND a.deleted_at IS NULL AND ${dateFilter}
      GROUP BY a.id, a.code, a.name, a.type, a.subtype, a.normal_balance, a.cash_flow_category, a.parent_id
      ORDER BY a.code ASC`);
  }

  private toRow(r: RawBalanceRow): AccountBalanceRow {
    const net =
      r.normal_balance === 'DEBIT' ? r.debit.sub(r.credit) : r.credit.sub(r.debit);
    return {
      accountId: r.account_id,
      code: r.code,
      name: r.name,
      type: r.type,
      subtype: r.subtype,
      normalBalance: r.normal_balance,
      cashFlowCategory: r.cash_flow_category,
      parentId: r.parent_id,
      debit: r.debit.toFixed(4),
      credit: r.credit.toFixed(4),
      balance: net.toFixed(4),
    };
  }

  /** Every account's cumulative debit/credit + metadata as of a date. */
  async balancesAsOf(asOf: Date): Promise<AccountBalanceRow[]> {
    const day = this.toUtcDay(asOf);
    const rows = await this.groupedBalances(Prisma.sql`je.date <= ${day}`);
    return rows.map((r) => this.toRow(r));
  }

  /** Every account's debit/credit movement over [from, to] (inclusive). */
  async movementsBetween(from: Date, to: Date): Promise<AccountBalanceRow[]> {
    const f = this.toUtcDay(from);
    const t = this.toUtcDay(to);
    const rows = await this.groupedBalances(
      Prisma.sql`je.date >= ${f} AND je.date <= ${t}`,
    );
    return rows.map((r) => this.toRow(r));
  }
```

Refactor `trialBalance` to reuse `groupedBalances` (preserve behavior — exclude all-zero rows, same output shape):

```typescript
  async trialBalance(asOf: Date): Promise<TrialBalance> {
    const day = this.toUtcDay(asOf);
    const rows = await this.groupedBalances(Prisma.sql`je.date <= ${day}`);
    let totalDebit = new Prisma.Decimal(0);
    let totalCredit = new Prisma.Decimal(0);
    const out: TrialBalanceRow[] = [];
    for (const r of rows) {
      if (r.debit.isZero() && r.credit.isZero()) continue; // preserve old HAVING
      totalDebit = totalDebit.add(r.debit);
      totalCredit = totalCredit.add(r.credit);
      const net =
        r.normal_balance === 'DEBIT' ? r.debit.sub(r.credit) : r.credit.sub(r.debit);
      out.push({
        accountId: r.account_id,
        code: r.code,
        name: r.name,
        debit: r.debit.toFixed(4),
        credit: r.credit.toFixed(4),
        balance: net.toFixed(4),
      });
    }
    return {
      asOf: asOf.toISOString().slice(0, 10),
      rows: out,
      totalDebit: totalDebit.toFixed(4),
      totalCredit: totalCredit.toFixed(4),
    };
  }
```
Leave `accountBalance` unchanged.

- [ ] **Step 3: Run the balances suite** — `npm run test:e2e -- balances` → PASS (the existing trial-balance + reversal + accountBalance cases MUST stay green; the two new primitive cases pass). Then `npm run test:e2e -- posting` (regression). `npm run build` + `npm run lint`.

- [ ] **Step 4: ReportingModule skeleton + AppModule**

Create `src/reporting/reporting.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [LedgerModule],
  providers: [],
  controllers: [],
  exports: [],
})
export class ReportingModule {}
```
In `src/app.module.ts`, import `ReportingModule` and add it to `imports` (after `InvoicingModule`). Confirm `LedgerModule` exports `BalancesService`, `AccountsService`, `PeriodsService`, `CompanyService` — it exports the first three; add `CompanyService` export if missing, OR import `CompanyModule` into `ReportingModule`. Simplest: add `CompanyModule` to `ReportingModule.imports`.

- [ ] **Step 5: Build, lint, commit**

```bash
npm run build && npm run lint
npm run test:e2e -- "balances|posting"
git add src/ledger/balances/balances.service.ts src/reporting src/app.module.ts test/balances.e2e-spec.ts
git commit -m "feat(reporting): BalancesService grouped primitives + module skeleton"
```

---

## Task 2: Neraca (balance sheet) + Laba Rugi (income statement)

**Files:** `src/reporting/balance-sheet.service.ts`, `src/reporting/income-statement.service.ts`, `src/reporting/dto/report-query.dto.ts`, `src/reporting/reports.controller.ts`, `src/reporting/reporting.module.ts`; Test: `test/reporting-statements.e2e-spec.ts`

- [ ] **Step 1: Query DTOs** `src/reporting/dto/report-query.dto.ts`:

```typescript
import { IsDateString, IsOptional, IsUUID } from 'class-validator';

export class AsOfQueryDto {
  @IsOptional() @IsDateString() asOf?: string;
}

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

- [ ] **Step 2 (TDD): write** `test/reporting-statements.e2e-spec.ts`. Seed a realistic scenario through the services so reports tie. Full setup (mirror the invoicing e2e harness; create a VIEWER token to prove read access):

```typescript
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Reporting statements (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let token: string;
  let acc: Record<string, string>;

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
    await app.get(CompanyService).seedIfEmpty();
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    await app.get(UsersService).create({ email: 'v@rep.test', password: 'secret123', name: 'V', role: 'VIEWER' });
    token = (await app.get(AuthService).login('v@rep.test', 'secret123')).accessToken;
    const accounts = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));

    const posting = app.get(PostingService);
    // Opening capital: Dr Kas 10,000,000 / Cr Modal 10,000,000
    await posting.post({ date: new Date('2026-01-01'), description: 'Modal awal', sourceType: 'OPENING', createdBy: 'sys',
      lines: [{ accountId: acc['1-1000'], debit: '10000000' }, { accountId: acc['3-1000'], credit: '10000000' }] }, 'sys');
    // A cash sale: Dr Kas 2,000,000 / Cr Pendapatan 2,000,000
    await posting.post({ date: new Date('2026-02-10'), description: 'Penjualan tunai', sourceType: 'MANUAL', createdBy: 'a',
      lines: [{ accountId: acc['1-1000'], debit: '2000000' }, { accountId: acc['4-1000'], credit: '2000000' }] }, 'p');
    // A cash expense: Dr Beban Gaji 500,000 / Cr Kas 500,000
    await posting.post({ date: new Date('2026-02-15'), description: 'Bayar gaji', sourceType: 'MANUAL', createdBy: 'a',
      lines: [{ accountId: acc['5-2000'], debit: '500000' }, { accountId: acc['1-1000'], credit: '500000' }] }, 'p');
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  const get = (url: string) =>
    request(app.getHttpServer() as App).get(url).set('Authorization', `Bearer ${token}`);

  it('balance sheet balances (Assets = Liabilities + Equity) and includes current earnings', async () => {
    const res = await get('/reports/balance-sheet?asOf=2026-12-31').expect(200);
    const body = res.body as { totalAssets: string; totalLiabilities: string; totalEquity: string; balanced: boolean; currentYearEarnings: string };
    // Assets: Kas 11,500,000. Equity: Modal 10,000,000 + earnings 1,500,000.
    expect(body.totalAssets).toBe('11500000.0000');
    expect(body.balanced).toBe(true);
    expect(Number(body.totalEquity)).toBeCloseTo(11500000, 4);
    expect(body.currentYearEarnings).toBe('1500000.0000');
  });

  it('income statement nets to 1,500,000 and ties to the balance sheet earnings', async () => {
    const res = await get('/reports/income-statement?from=2026-01-01&to=2026-12-31').expect(200);
    const body = res.body as { revenue: string; netIncome: string };
    expect(body.revenue).toBe('2000000.0000');
    expect(body.netIncome).toBe('1500000.0000'); // 2,000,000 − 500,000
  });

  it('rejects from > to (422) and is reachable by a VIEWER', async () => {
    await get('/reports/income-statement?from=2026-12-31&to=2026-01-01').expect(422);
  });
});
```
Run `npm run test:e2e -- reporting-statements` → FAIL.

- [ ] **Step 3: BalanceSheetService** `src/reporting/balance-sheet.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { Money } from '../common/money/money';
import { BalancesService, AccountBalanceRow } from '../ledger/balances/balances.service';
import { CompanyService } from '../company/company.service';

export interface ReportLine { code: string; name: string; amount: string; }
export interface ReportGroup { subtype: string; lines: ReportLine[]; subtotal: string; }

@Injectable()
export class BalanceSheetService {
  constructor(
    private readonly balances: BalancesService,
    private readonly company: CompanyService,
  ) {}

  /** ASSET → debit−credit; LIABILITY/EQUITY → credit−debit (handles contras). */
  private bsAmount(r: AccountBalanceRow): Money {
    const d = Money.of(r.debit);
    const c = Money.of(r.credit);
    return r.type === 'ASSET' ? d.subtract(c) : c.subtract(d);
  }

  private group(rows: AccountBalanceRow[]): { groups: ReportGroup[]; total: Money } {
    const bySubtype = new Map<string, ReportLine[]>();
    let total = Money.zero();
    for (const r of rows) {
      const amt = this.bsAmount(r);
      total = total.add(amt);
      const lines = bySubtype.get(r.subtype) ?? [];
      lines.push({ code: r.code, name: r.name, amount: amt.toPersistence() });
      bySubtype.set(r.subtype, lines);
    }
    const groups: ReportGroup[] = [...bySubtype.entries()].map(([subtype, lines]) => ({
      subtype,
      lines,
      subtotal: lines.reduce((s, l) => s.add(Money.of(l.amount)), Money.zero()).toPersistence(),
    }));
    return { groups, total };
  }

  async generate(asOf: Date) {
    const settings = await this.company.get();
    const month = asOf.getUTCMonth() + 1;
    const fy = month >= settings.fiscalYearStartMonth ? asOf.getUTCFullYear() : asOf.getUTCFullYear() - 1;
    const fyStart = new Date(Date.UTC(fy, settings.fiscalYearStartMonth - 1, 1));

    const rows = await this.balances.balancesAsOf(asOf);
    const assets = this.group(rows.filter((r) => r.type === 'ASSET'));
    const liabilities = this.group(rows.filter((r) => r.type === 'LIABILITY'));
    const equityRows = rows.filter((r) => r.type === 'EQUITY');
    const eq = this.group(equityRows);

    // Cumulative earnings = Σ(credit − debit) over all P&L rows (revenue − expense).
    const pl = rows.filter((r) => r.type === 'REVENUE' || r.type === 'EXPENSE');
    const cumulativeEarnings = pl.reduce(
      (s, r) => s.add(Money.of(r.credit).subtract(Money.of(r.debit))), Money.zero(),
    );
    // Current-FY portion (sub-figure).
    const fyRows = await this.balances.movementsBetween(fyStart, asOf);
    const currentYearEarnings = fyRows
      .filter((r) => r.type === 'REVENUE' || r.type === 'EXPENSE')
      .reduce((s, r) => s.add(Money.of(r.credit).subtract(Money.of(r.debit))), Money.zero());

    const equityGroups = [
      ...eq.groups,
      { subtype: 'CURRENT_EARNINGS', lines: [{ code: '', name: 'Laba (Rugi) Berjalan', amount: cumulativeEarnings.toPersistence() }], subtotal: cumulativeEarnings.toPersistence() },
    ];
    const totalEquity = eq.total.add(cumulativeEarnings);

    return {
      asOf: asOf.toISOString().slice(0, 10),
      assets: { groups: assets.groups, total: assets.total.toPersistence() },
      liabilities: { groups: liabilities.groups, total: liabilities.total.toPersistence() },
      equity: { groups: equityGroups, total: totalEquity.toPersistence() },
      totalAssets: assets.total.toPersistence(),
      totalLiabilities: liabilities.total.toPersistence(),
      totalEquity: totalEquity.toPersistence(),
      currentYearEarnings: currentYearEarnings.toPersistence(),
      balanced: assets.total.equals(liabilities.total.add(totalEquity)),
    };
  }
}
```

- [ ] **Step 4: IncomeStatementService** `src/reporting/income-statement.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { Money } from '../common/money/money';
import { BalancesService, AccountBalanceRow } from '../ledger/balances/balances.service';

const TAX_EXPENSE_CODE = '5-9000';
export interface ReportLine { code: string; name: string; amount: string; }

@Injectable()
export class IncomeStatementService {
  constructor(private readonly balances: BalancesService) {}

  /** credit−debit for revenue/income; debit−credit for cost/expense. Magnitudes positive. */
  private mag(r: AccountBalanceRow): Money {
    const d = Money.of(r.debit);
    const c = Money.of(r.credit);
    return r.type === 'REVENUE' ? c.subtract(d) : d.subtract(c);
  }

  private section(rows: AccountBalanceRow[], pred: (r: AccountBalanceRow) => boolean) {
    const lines: ReportLine[] = [];
    let total = Money.zero();
    for (const r of rows.filter(pred)) {
      const amt = this.mag(r);
      total = total.add(amt);
      lines.push({ code: r.code, name: r.name, amount: amt.toPersistence() });
    }
    return { lines, total };
  }

  async generate(from: Date, to: Date) {
    const all = (await this.balances.movementsBetween(from, to)).filter(
      (r) => r.type === 'REVENUE' || r.type === 'EXPENSE',
    );
    // Pull the income-tax-expense account out FIRST (whatever subtype it carries),
    // so it appears only on its own line and never double-counts in a subtype section.
    const taxRows = all.filter((r) => r.code === TAX_EXPENSE_CODE);
    const rows = all.filter((r) => r.code !== TAX_EXPENSE_CODE);
    const revenue = this.section(rows, (r) => r.subtype === 'REVENUE');
    const cogs = this.section(rows, (r) => r.subtype === 'COGS');
    const grossProfit = revenue.total.subtract(cogs.total);
    const opex = this.section(rows, (r) => r.subtype === 'OPERATING_EXPENSE');
    const operatingProfit = grossProfit.subtract(opex.total);
    const otherIncome = this.section(rows, (r) => r.subtype === 'OTHER_INCOME');
    const otherExpense = this.section(rows, (r) => r.subtype === 'OTHER_EXPENSE');
    const profitBeforeTax = operatingProfit.add(otherIncome.total).subtract(otherExpense.total);
    const tax = this.section(taxRows, () => true);
    const netIncome = profitBeforeTax.subtract(tax.total);

    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      revenue: revenue.total.toPersistence(),
      revenueLines: revenue.lines,
      cogs: cogs.total.toPersistence(),
      cogsLines: cogs.lines,
      grossProfit: grossProfit.toPersistence(),
      operatingExpense: opex.total.toPersistence(),
      operatingExpenseLines: opex.lines,
      operatingProfit: operatingProfit.toPersistence(),
      otherIncome: otherIncome.total.toPersistence(),
      otherExpense: otherExpense.total.toPersistence(),
      profitBeforeTax: profitBeforeTax.toPersistence(),
      taxExpense: tax.total.toPersistence(),
      netIncome: netIncome.toPersistence(),
    };
  }
}
```

- [ ] **Step 5: Controller** `src/reporting/reports.controller.ts` (start with these two; later tasks add routes):

```typescript
import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { AsOfQueryDto, RangeQueryDto } from './dto/report-query.dto';
import { BalanceSheetService } from './balance-sheet.service';
import { IncomeStatementService } from './income-statement.service';
import { ValidationFailedError } from '../common/errors/domain-errors';

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly balanceSheet: BalanceSheetService,
    private readonly incomeStatement: IncomeStatementService,
  ) {}

  private range(q: { from: string; to: string }): { from: Date; to: Date } {
    const from = new Date(q.from);
    const to = new Date(q.to);
    if (from.getTime() > to.getTime()) {
      throw new ValidationFailedError('`from` must be on or before `to`', { from: q.from, to: q.to });
    }
    return { from, to };
  }

  @Get('balance-sheet')
  balanceSheet(@Query() q: AsOfQueryDto) {
    return this.balanceSheet.generate(q.asOf ? new Date(q.asOf) : new Date());
  }

  @Get('income-statement')
  incomeStatement(@Query() q: RangeQueryDto) {
    const { from, to } = this.range(q);
    return this.incomeStatement.generate(from, to);
  }
}
```
(`BadRequestException` import unused — remove it; the `ValidationFailedError` maps to 422 via the filter.)

- [ ] **Step 6: Register** `BalanceSheetService`, `IncomeStatementService` (providers), `ReportsController` (controllers) in `ReportingModule` (imports `LedgerModule` + `CompanyModule`).

- [ ] **Step 7: Run** `npm run test:e2e -- reporting-statements` → 3 PASS. `npm run lint`.

- [ ] **Step 8: Commit**

```bash
git add src/reporting test/reporting-statements.e2e-spec.ts
git commit -m "feat(reporting): Neraca + Laba Rugi"
```

---

## Task 3: Buku Besar (general ledger detail)

**Files:** `src/reporting/general-ledger.service.ts`, `reports.controller.ts` (add route), `reporting.module.ts`; Test: `test/reporting-ledger.e2e-spec.ts`

- [ ] **Step 1 (TDD): write** `test/reporting-ledger.e2e-spec.ts` — same harness/seed as Task 2 (factor the seed inline). Resolve `kasId = acc['1-1000']`. Assert for `GET /reports/general-ledger?accountId=<kas>&from=2026-01-01&to=2026-12-31`:
  - `openingBalance` === `'0.0000'` (nothing before 2026); `lines.length` === 3 (opening capital, sale, expense); the running balance after the 3 lines === `closingBalance` === `'11500000.0000'` (10,000,000 + 2,000,000 − 500,000); each line has `entryRef`, `debit`, `credit`, `runningBalance`.
  Run → FAIL.

- [ ] **Step 2: GeneralLedgerService** `src/reporting/general-ledger.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import { AccountsService } from '../ledger/accounts/accounts.service';
import { BalancesService } from '../ledger/balances/balances.service';

interface LineRow {
  date: Date; entry_ref: string | null; description: string | null;
  debit: Prisma.Decimal; credit: Prisma.Decimal;
}

@Injectable()
export class GeneralLedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly balances: BalancesService,
  ) {}

  private day(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  async generate(accountId: string, from: Date, to: Date) {
    const account = await this.accounts.findById(accountId); // 404 if missing
    const debitNormal = account.normalBalance === 'DEBIT';
    const dayBefore = new Date(this.day(from).getTime() - 86_400_000);
    const opening = await this.balances.accountBalance(accountId, dayBefore);
    let running = Money.of(opening.balance);

    const rows = await this.prisma.$queryRaw<LineRow[]>(Prisma.sql`
      SELECT je.date, je.entry_ref, jl.description, jl.debit, jl.credit
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.account_id = ${accountId} AND je.posted_at IS NOT NULL
        AND je.date >= ${this.day(from)} AND je.date <= ${this.day(to)}
      ORDER BY je.date ASC, je.entry_number ASC`);

    const lines = rows.map((r) => {
      const delta = debitNormal
        ? Money.of(r.debit.toString()).subtract(Money.of(r.credit.toString()))
        : Money.of(r.credit.toString()).subtract(Money.of(r.debit.toString()));
      running = running.add(delta);
      return {
        date: r.date.toISOString().slice(0, 10),
        entryRef: r.entry_ref,
        description: r.description,
        debit: r.debit.toFixed(4),
        credit: r.credit.toFixed(4),
        runningBalance: running.toPersistence(),
      };
    });

    return {
      account: { id: account.id, code: account.code, name: account.name, normalBalance: account.normalBalance },
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      openingBalance: Money.of(opening.balance).toPersistence(),
      lines,
      closingBalance: running.toPersistence(),
    };
  }
}
```

- [ ] **Step 3: Controller route** — add to `ReportsController` (inject `GeneralLedgerService`):

```typescript
  @Get('general-ledger')
  generalLedger(@Query() q: LedgerQueryDto) {
    const { from, to } = this.range(q);
    return this.generalLedger.generate(q.accountId, from, to);
  }
```
(import `LedgerQueryDto`; add `private readonly generalLedger: GeneralLedgerService` to the constructor.)

- [ ] **Step 4: Register** `GeneralLedgerService` in `ReportingModule`. Run `npm run test:e2e -- reporting-ledger` → PASS. `npm run lint`.

- [ ] **Step 5: Commit** `git commit -m "feat(reporting): Buku Besar (general ledger)"`

---

## Task 4: AR/AP Aging

**Files:** `src/reporting/aging.service.ts`, `reports.controller.ts` (add 2 routes), `reporting.module.ts`; Test: `test/reporting-aging.e2e-spec.ts`

- [ ] **Step 1 (TDD): write** `test/reporting-aging.e2e-spec.ts` — seed via the invoicing services (so the subledger + GL both exist and tie). Setup: seed accounts/tax/periods 2026 (+ company SoD off); ACCOUNTANT+APPROVER tokens; a customer partner; post a sales invoice dated 2026-01-10 due 2026-02-09 of total 1,110,000 (line 4-1000 qty 1 unitPrice 1000000 + PPN-OUT-11) and a second invoice dated 2026-06-01 due 2026-07-01; post a RECEIPT of 500,000 against the first. Assert for `GET /reports/ar-aging?asOf=2026-03-15`:
  - the first invoice's outstanding-as-of === `'610000.0000'` (1,110,000 − 500,000) and bucket is `'1-30'` or `'31-60'` (due 2026-02-09, asOf 2026-03-15 → ~34 days → '31-60'); the second invoice (dated 2026-06-01 > asOf) is ABSENT.
  - grand total outstanding === the AR control balance: `Σ outstanding === Number((await app.get(BalancesService).accountBalance(acc['1-1200'], new Date('2026-03-15'))).balance)`.
  Run → FAIL.

- [ ] **Step 2: AgingService** `src/reporting/aging.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';

interface DocRow {
  id: string; ref: string | null; partner_id: string; partner_name: string;
  date: Date; due_date: Date | null; total: Prisma.Decimal; paid_as_of: Prisma.Decimal;
}

const BUCKETS = ['Current', '1-30', '31-60', '61-90', '>90'] as const;

@Injectable()
export class AgingService {
  constructor(private readonly prisma: PrismaService) {}

  private day(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  private bucketOf(daysPastDue: number): string {
    if (daysPastDue <= 0) return 'Current';
    if (daysPastDue <= 30) return '1-30';
    if (daysPastDue <= 60) return '31-60';
    if (daysPastDue <= 90) return '61-90';
    return '>90';
  }

  /** kind: 'AR' (sales_invoices + sales_invoice_id) | 'AP' (purchase_bills + purchase_bill_id) */
  async aging(kind: 'AR' | 'AP', asOf: Date) {
    const day = this.day(asOf);
    const docTable = kind === 'AR' ? Prisma.raw('sales_invoices') : Prisma.raw('purchase_bills');
    const allocCol = kind === 'AR' ? Prisma.raw('sales_invoice_id') : Prisma.raw('purchase_bill_id');

    const rows = await this.prisma.$queryRaw<DocRow[]>(Prisma.sql`
      SELECT d.id, ${kind === 'AR' ? Prisma.raw('d.invoice_ref') : Prisma.raw('d.bill_ref')} AS ref,
             d.partner_id, bp.name AS partner_name, d.date, d.due_date, d.total,
             COALESCE((
               SELECT SUM(pa.amount) FROM payment_allocations pa
               JOIN payments p ON p.id = pa.payment_id
               WHERE pa.${allocCol} = d.id AND p.status = 'POSTED' AND p.deleted_at IS NULL AND p.date <= ${day}
             ), 0) AS paid_as_of
      FROM ${docTable} d
      JOIN business_partners bp ON bp.id = d.partner_id
      WHERE d.status = 'POSTED' AND d.deleted_at IS NULL AND d.date <= ${day}
      ORDER BY bp.name ASC, d.date ASC`);

    const byPartner = new Map<string, { partnerId: string; partnerName: string; rows: { ref: string | null; date: string; dueDate: string | null; total: string; paidAsOf: string; outstanding: string; bucket: string }[]; buckets: Record<string, Money> }>();
    const grand: Record<string, Money> = Object.fromEntries(BUCKETS.map((b) => [b, Money.zero()]));
    let grandTotal = Money.zero();

    for (const r of rows) {
      const outstanding = Money.of(r.total.toString()).subtract(Money.of(r.paid_as_of.toString()));
      if (outstanding.isZero() || outstanding.isNegative()) continue;
      const dueOrDate = r.due_date ?? r.date;
      const daysPastDue = Math.floor((day.getTime() - this.day(dueOrDate).getTime()) / 86_400_000);
      const bucket = this.bucketOf(daysPastDue);
      const g = byPartner.get(r.partner_id) ?? { partnerId: r.partner_id, partnerName: r.partner_name, rows: [], buckets: Object.fromEntries(BUCKETS.map((b) => [b, Money.zero()])) };
      g.rows.push({
        ref: r.ref, date: r.date.toISOString().slice(0, 10),
        dueDate: r.due_date ? r.due_date.toISOString().slice(0, 10) : null,
        total: Money.of(r.total.toString()).toPersistence(),
        paidAsOf: Money.of(r.paid_as_of.toString()).toPersistence(),
        outstanding: outstanding.toPersistence(), bucket,
      });
      g.buckets[bucket] = g.buckets[bucket].add(outstanding);
      byPartner.set(r.partner_id, g);
      grand[bucket] = grand[bucket].add(outstanding);
      grandTotal = grandTotal.add(outstanding);
    }

    return {
      kind, asOf: asOf.toISOString().slice(0, 10),
      partners: [...byPartner.values()].map((g) => ({
        partnerId: g.partnerId, partnerName: g.partnerName, documents: g.rows,
        buckets: Object.fromEntries(BUCKETS.map((b) => [b, g.buckets[b].toPersistence()])),
      })),
      totalsByBucket: Object.fromEntries(BUCKETS.map((b) => [b, grand[b].toPersistence()])),
      totalOutstanding: grandTotal.toPersistence(),
    };
  }
}
```

- [ ] **Step 3: Controller routes** — add to `ReportsController` (inject `AgingService`):

```typescript
  @Get('ar-aging')
  arAging(@Query() q: AsOfQueryDto) {
    return this.aging.aging('AR', q.asOf ? new Date(q.asOf) : new Date());
  }

  @Get('ap-aging')
  apAging(@Query() q: AsOfQueryDto) {
    return this.aging.aging('AP', q.asOf ? new Date(q.asOf) : new Date());
  }
```

- [ ] **Step 4: Register** `AgingService`. Run `npm run test:e2e -- reporting-aging` → PASS. `npm run lint`.

- [ ] **Step 5: Commit** `git commit -m "feat(reporting): AR/AP aging (as-of-historical, ties to control)"`

---

## Task 5: Arus Kas (cash flow, indirect)

**Files:** `src/reporting/cash-flow.service.ts`, `reports.controller.ts` (add route), `reporting.module.ts`; Test: `test/reporting-cashflow.e2e-spec.ts`

- [ ] **Step 1 (TDD): write** `test/reporting-cashflow.e2e-spec.ts` — same seed as Task 2 (opening capital 10M, cash sale 2M, cash expense 0.5M; all hit Kas). For `GET /reports/cash-flow?from=2026-01-01&to=2026-12-31`:
  - `reconciles` === `true`; `kasAwal` === `'0.0000'`; `kasAkhir` === `'11500000.0000'`; `netChange` === `'11500000.0000'`; `netIncome` === `'1500000.0000'`; operating + investing + financing === netChange. (Here financing includes the 10M Modal; operating includes net income 1.5M.)
  Run → FAIL.

- [ ] **Step 2: CashFlowService** `src/reporting/cash-flow.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { Money } from '../common/money/money';
import { BalancesService, AccountBalanceRow } from '../ledger/balances/balances.service';

const CASH_CODES = new Set(['1-1000', '1-1100']);

export interface CashFlowLine { code: string; name: string; amount: string; }

@Injectable()
export class CashFlowService {
  constructor(private readonly balances: BalancesService) {}

  /** Cash provided by an account's movement = credit − debit. */
  private cashEffect(r: AccountBalanceRow): Money {
    return Money.of(r.credit).subtract(Money.of(r.debit));
  }

  private cashBalance(rows: AccountBalanceRow[]): Money {
    // Kas/Bank are debit-normal assets: balance = debit − credit.
    return rows.filter((r) => CASH_CODES.has(r.code))
      .reduce((s, r) => s.add(Money.of(r.debit).subtract(Money.of(r.credit))), Money.zero());
  }

  async generate(from: Date, to: Date) {
    const movements = await this.balances.movementsBetween(from, to);
    const nonCash = movements.filter((r) => !CASH_CODES.has(r.code));

    // Net income = Σ cash-effect of P&L accounts.
    const pl = nonCash.filter((r) => r.type === 'REVENUE' || r.type === 'EXPENSE');
    const netIncome = pl.reduce((s, r) => s.add(this.cashEffect(r)), Money.zero());

    // Non-P&L, non-cash accounts grouped by cashFlowCategory (NONE → OPERATING).
    const bs = nonCash.filter((r) => r.type !== 'REVENUE' && r.type !== 'EXPENSE');
    const bucket = (cat: string): 'OPERATING' | 'INVESTING' | 'FINANCING' =>
      cat === 'INVESTING' ? 'INVESTING' : cat === 'FINANCING' ? 'FINANCING' : 'OPERATING';
    const sections: Record<string, { lines: CashFlowLine[]; total: Money }> = {
      OPERATING: { lines: [], total: Money.zero() },
      INVESTING: { lines: [], total: Money.zero() },
      FINANCING: { lines: [], total: Money.zero() },
    };
    for (const r of bs) {
      const amt = this.cashEffect(r);
      if (amt.isZero()) continue;
      const sec = sections[bucket(r.cashFlowCategory)];
      sec.lines.push({ code: r.code, name: r.name, amount: amt.toPersistence() });
      sec.total = sec.total.add(amt);
    }

    const operating = netIncome.add(sections.OPERATING.total);
    const investing = sections.INVESTING.total;
    const financing = sections.FINANCING.total;
    const netChange = operating.add(investing).add(financing);

    const dayBefore = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()) - 86_400_000);
    const kasAwal = this.cashBalance(await this.balances.balancesAsOf(dayBefore));
    const kasAkhir = this.cashBalance(await this.balances.balancesAsOf(to));

    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      netIncome: netIncome.toPersistence(),
      operating: { adjustments: sections.OPERATING.lines, total: operating.toPersistence() },
      investing: { lines: sections.INVESTING.lines, total: investing.toPersistence() },
      financing: { lines: sections.FINANCING.lines, total: financing.toPersistence() },
      netChange: netChange.toPersistence(),
      kasAwal: kasAwal.toPersistence(),
      kasAkhir: kasAkhir.toPersistence(),
      reconciles: kasAwal.add(netChange).equals(kasAkhir),
    };
  }
}
```

- [ ] **Step 3: Controller route** — add to `ReportsController` (inject `CashFlowService`):

```typescript
  @Get('cash-flow')
  cashFlow(@Query() q: RangeQueryDto) {
    const { from, to } = this.range(q);
    return this.cashFlow.generate(from, to);
  }
```

- [ ] **Step 4: Register** `CashFlowService`. Run `npm run test:e2e -- reporting-cashflow` → PASS.

- [ ] **Step 5: Full verification**

```bash
npm run build && npm run lint && npm test && npm run test:e2e
```
All green.

- [ ] **Step 6: Commit** `git commit -m "feat(reporting): Arus Kas (indirect, reconciles to Δcash)"`

---

## Self-review (against the spec)

**Spec coverage:**
- §2 module + `balancesAsOf`/`movementsBetween` primitives (shared builder) → Task 1 ✓
- §3 Neraca (type/subtype groups, contra-correct via type-based signing, synthetic cumulative-earnings line + current-FY sub-figure, `balanced`) → Task 2 BalanceSheetService ✓
- §4 Laba Rugi (SAK sections, Beban Pajak by code 5-9000, cross-report tie) → Task 2 IncomeStatementService + e2e ✓
- §5 Buku Besar (per-account opening/running/closing) → Task 3 ✓
- §6 AR/AP aging (as-of outstanding from payment-dated allocations, buckets, control reconciliation) → Task 4 ✓
- §7 Arus Kas (credit−debit cash-effect by cashFlowCategory, net income line, cash by code, reconciles) → Task 5 ✓
- §8 API (any-auth incl VIEWER, from>to → 422, 4dp) → Task 2 controller + DTOs + the range guard ✓
- §9 testing (balanced, cross-report tie, opening/running/closing, aging↔control, cash reconciles, VIEWER) → each task's e2e ✓

**Placeholder scan:** none — every step has full code. (The Task-2 controller note flags removing the unused `BadRequestException` import.)

**Type consistency:** `AccountBalanceRow` (exported from balances.service) is consumed by BalanceSheet/IncomeStatement/CashFlow services with matching fields (`type`/`subtype`/`cashFlowCategory`/`debit`/`credit`); `balancesAsOf(asOf)`/`movementsBetween(from,to)` signatures match all call sites; `Money` API (`of`/`zero`/`add`/`subtract`/`equals`/`isZero`/`isNegative`/`toPersistence`) matches the codebase; control/cash/tax codes (`1-1200`/`2-1000`/`1-1000`/`1-1100`/`5-9000`) exist in the chart; `accountBalance`/`findById` signatures match. The sign conventions (type-based for balance sheet/P&L; credit−debit for cash flow) are stated once at the top and applied identically in every service.
