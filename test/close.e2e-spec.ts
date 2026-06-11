import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { BalancesService } from '../src/ledger/balances/balances.service';
import { BalanceSheetService } from '../src/reporting/balance-sheet.service';
import { CashFlowService } from '../src/reporting/cash-flow.service';
import { YearEndCloseService } from '../src/close/year-end-close.service';
import { JournalService } from '../src/ledger/journal/journal.service';
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
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
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
    await posting.post(
      {
        date: new Date('2026-02-10'),
        description: 'Sale',
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '2000000' },
          { accountId: acc['4-1000'], credit: '2000000' },
        ],
      },
      'p',
    );
    await posting.post(
      {
        date: new Date('2026-02-15'),
        description: 'Expense',
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: acc['5-2000'], debit: '500000' },
          { accountId: acc['1-1000'], credit: '500000' },
        ],
      },
      'p',
    );
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  const plBalance = async (): Promise<number> => {
    const rows = await balances.balancesAsOf(new Date('2026-12-31'));
    return rows
      .filter((r) => r.type === 'REVENUE' || r.type === 'EXPENSE')
      .reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0);
  };

  it('closes the year: zeroes P&L, nets to Laba Ditahan, marks CLOSED', async () => {
    expect(await plBalance()).not.toBe(0);
    const rec = await close.close(2026, 'admin');
    expect(rec.status).toBe('CLOSED');
    // netIncome is a Prisma.Decimal; normalize to 4dp for comparison.
    expect(rec.netIncome.toFixed(4)).toBe('1500000.0000'); // 2,000,000 − 500,000
    expect(await plBalance()).toBe(0); // P&L zeroed as of year-end
    const ret = await balances.accountBalance(
      acc['3-2000'],
      new Date('2026-12-31'),
    );
    expect(ret.balance).toBe('1500000.0000'); // net income moved to Laba Ditahan
  });

  it('after close: Neraca current-year earnings is 0 and cash-flow still reconciles', async () => {
    // (run after the close test, before reopen — re-close if needed)
    const status = await close.getStatus(2026);
    if (status?.status !== 'CLOSED') await close.close(2026, 'admin');
    const bs = await app
      .get(BalanceSheetService)
      .generate(new Date('2026-12-31'));
    expect(bs.currentYearEarnings).toBe('0.0000'); // P&L closed out
    expect(bs.balanced).toBe(true);
    const cf = await app
      .get(CashFlowService)
      .generate(new Date('2026-01-01'), new Date('2026-12-31'));
    expect(cf.reconciles).toBe(true);
  });

  it('blocks new posting into the closed year, allows the next year', async () => {
    await expect(
      posting.post(
        {
          date: new Date('2026-06-01'),
          description: 'late',
          sourceType: 'MANUAL',
          createdBy: 'a',
          lines: [
            { accountId: acc['1-1000'], debit: '100' },
            { accountId: acc['4-1000'], credit: '100' },
          ],
        },
        'p',
      ),
    ).rejects.toBeInstanceOf(ClosedYearError);
    // 2027 is open
    const ok = await posting.post(
      {
        date: new Date('2027-02-01'),
        description: 'next yr',
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '100' },
          { accountId: acc['4-1000'], credit: '100' },
        ],
      },
      'p',
    );
    expect(ok.status).toBe('POSTED');
  });

  it('is idempotent: re-closing a closed year is rejected', async () => {
    await expect(close.close(2026, 'admin')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('reopens: reverses the closing entry, restores P&L, allows posting again', async () => {
    const rec = await close.reopen(2026, 'admin');
    expect(rec.status).toBe('OPEN');
    expect(await plBalance()).not.toBe(0); // P&L restored by the reversal
    const ok = await posting.post(
      {
        date: new Date('2026-06-01'),
        description: 'correction',
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '100' },
          { accountId: acc['4-1000'], credit: '100' },
        ],
      },
      'p',
    );
    expect(ok.status).toBe('POSTED');
  });

  it('blocks posting a DRAFT into a year closed after the draft was created', async () => {
    await app.get(PeriodsService).generatePeriods(2030);
    const journal = app.get(JournalService);
    const draft = await journal.createDraft({
      date: new Date('2030-03-01'),
      description: 'draft created while 2030 was open',
      createdBy: 'a',
      lines: [
        { accountId: acc['1-1000'], debit: '100' },
        { accountId: acc['4-1000'], credit: '100' },
      ],
    });
    await close.close(2030, 'admin'); // closes 2030 after the draft exists
    await expect(journal.postDraft(draft.id, 'p')).rejects.toBeInstanceOf(
      ClosedYearError,
    );
  });
});
