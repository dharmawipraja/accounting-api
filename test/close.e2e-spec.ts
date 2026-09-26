import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
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
import {
  ClosedYearError,
  InvalidAccountError,
} from '../src/common/errors/domain-errors';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';

describe('Year-end close (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let acc: Record<string, string>;
  let close: YearEndCloseService;
  let posting: PostingService;
  let balances: BalancesService;
  let adminToken: string;

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp({ pipe: false }));
    await app.get(CompanyService).seedIfEmpty();
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2006);
    await app.get(PeriodsService).generatePeriods(2007);
    const { data: accounts } = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    posting = app.get(PostingService);
    close = app.get(YearEndCloseService);
    balances = app.get(BalancesService);
    await app.get(UsersService).create({
      email: 'admin@close.test',
      password: 'secret123',
      name: 'Admin',
      role: 'ADMIN',
    });
    adminToken = (
      await app.get(AuthService).login('admin@close.test', 'secret123')
    ).accessToken;
    // 2006 P&L: revenue 2,000,000 (Cr 4-1000 / Dr Kas) and expense 500,000 (Dr 5-2000 / Cr Kas).
    await posting.post(
      {
        date: new Date('2006-02-10'),
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
        date: new Date('2006-02-15'),
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

  afterAll(() => cleanup());

  const plBalance = async (): Promise<number> => {
    const rows = await balances.balancesAsOf(new Date('2006-12-31'));
    return rows
      .filter((r) => r.type === 'REVENUE' || r.type === 'EXPENSE')
      .reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0);
  };

  it('closes the year: zeroes P&L, nets to Laba Ditahan, marks CLOSED', async () => {
    expect(await plBalance()).not.toBe(0);
    const rec = await close.close(2006, 'admin');
    expect(rec.status).toBe('CLOSED');
    // netIncome is a Prisma.Decimal; normalize to 4dp for comparison.
    expect(rec.netIncome.toFixed(4)).toBe('1500000.0000'); // 2,000,000 − 500,000
    expect(await plBalance()).toBe(0); // P&L zeroed as of year-end
    const ret = await balances.accountBalance(
      acc['3-2000'],
      new Date('2006-12-31'),
    );
    expect(ret.balance).toBe('1500000.0000'); // net income moved to Laba Ditahan
  });

  it('after close: Neraca at year-end is pre-closing (earnings = net income) and cash-flow still reconciles', async () => {
    // (run after the close test, before reopen — re-close if needed)
    const status = await close.getStatus(2006);
    if (status?.status !== 'CLOSED') await close.close(2006, 'admin');
    const bs = await app
      .get(BalanceSheetService)
      .generate(new Date('2006-12-31'));
    // The closing entry dated on the report date is excluded (pre-closing view),
    // so the year's profit still shows as current-year earnings.
    expect(bs.currentYearEarnings).toBe('1500000.0000');
    expect(bs.balanced).toBe(true);
    const cf = await app
      .get(CashFlowService)
      .generate(new Date('2006-01-01'), new Date('2006-12-31'));
    expect(cf.reconciles).toBe(true);
  });

  it('blocks new posting into the closed year, allows the next year', async () => {
    await expect(
      posting.post(
        {
          date: new Date('2006-06-01'),
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
    // 2007 is open
    const ok = await posting.post(
      {
        date: new Date('2007-02-01'),
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
    await expect(close.close(2006, 'admin')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('reopens: reverses the closing entry, restores P&L, allows posting again', async () => {
    const rec = await close.reopen(2006, 'admin');
    expect(rec.status).toBe('OPEN');
    expect(await plBalance()).not.toBe(0); // P&L restored by the reversal
    const ok = await posting.post(
      {
        date: new Date('2006-06-01'),
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
    await app.get(PeriodsService).generatePeriods(2010);
    const journal = app.get(JournalService);
    const draft = await journal.createDraft({
      date: new Date('2010-03-01'),
      description: 'draft created while 2010 was open',
      createdBy: 'a',
      lines: [
        { accountId: acc['1-1000'], debit: '100' },
        { accountId: acc['4-1000'], credit: '100' },
      ],
    });
    await close.close(2010, 'admin'); // closes 2010 after the draft exists
    await expect(journal.postDraft(draft.id, 'p')).rejects.toBeInstanceOf(
      ClosedYearError,
    );
  });

  it('C-1: P&L account with zero net movement is omitted from the closing entry', async () => {
    // C-1: zero-movement line is skipped (position.isZero() continue in close())
    await app.get(PeriodsService).generatePeriods(2009);
    await posting.post(
      {
        date: new Date('2009-03-01'),
        description: 'C-1 revenue',
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '1000000' },
          { accountId: acc['4-1000'], credit: '1000000' },
        ],
      },
      'p',
    );
    // Offsetting entry: net revenue = 0
    await posting.post(
      {
        date: new Date('2009-03-02'),
        description: 'C-1 revenue offset',
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: acc['4-1000'], debit: '1000000' },
          { accountId: acc['1-1000'], credit: '1000000' },
        ],
      },
      'p',
    );
    const rec = await close.close(2009, 'admin');
    // Net P&L = 0 → empty year → no closing entry
    expect(rec.closingEntryId).toBeNull();
    expect(rec.netIncome.toFixed(4)).toBe('0.0000');
  });

  it('C-3: closing a loss year debits retained earnings', async () => {
    // C-3: netIncome is negative (loss) → RETAINED_EARNINGS is debited
    await app.get(PeriodsService).generatePeriods(2012);
    await posting.post(
      {
        date: new Date('2012-03-01'),
        description: 'C-3 revenue',
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '500000' },
          { accountId: acc['4-1000'], credit: '500000' },
        ],
      },
      'p',
    );
    await posting.post(
      {
        date: new Date('2012-03-02'),
        description: 'C-3 expense',
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: acc['5-2000'], debit: '1200000' },
          { accountId: acc['1-1000'], credit: '1200000' },
        ],
      },
      'p',
    );
    const rec = await close.close(2012, 'admin');
    expect(rec.status).toBe('CLOSED');
    // Net income = 500,000 − 1,200,000 = −700,000 (loss)
    expect(rec.netIncome.toFixed(4)).toBe('-700000.0000');
    const lines = await prisma.client.journalLine.findMany({
      where: { journalEntryId: rec.closingEntryId! },
    });
    const retainedLine = lines.find((l) => l.accountId === acc['3-2000']);
    expect(retainedLine).toBeDefined();
    expect(Number(retainedLine!.debit)).toBeGreaterThan(0);
    expect(Number(retainedLine!.credit)).toBe(0);
  });

  it('C-5: reopening a never-closed year throws VALIDATION_FAILED', async () => {
    // C-5: reopen() — no close record for fiscal year → ValidationFailedError
    await app.get(PeriodsService).generatePeriods(2015);
    await expect(close.reopen(2015, 'admin')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('C-7: reopening an empty-year close sets status to OPEN without reversal', async () => {
    // C-7: reopen() with closingEntryId === null → no reversal attempted, status → OPEN
    await app.get(PeriodsService).generatePeriods(2013);
    const closedRec = await close.close(2013, 'admin');
    expect(closedRec.closingEntryId).toBeNull(); // empty year
    const reopenedRec = await close.reopen(2013, 'admin');
    expect(reopenedRec.status).toBe('OPEN');
    expect(reopenedRec.closingEntryId).toBeNull();
  });

  it('closes, reopens and re-closes a year whose P&L account was deactivated mid-year; MANUAL posts to it still 422', async () => {
    await app.get(PeriodsService).generatePeriods(2016);
    const accounts = app.get(AccountsService);
    const rev = await accounts.create({
      code: '4-1036',
      name: 'Pendapatan Lini Lama',
      type: 'REVENUE',
      subtype: 'REVENUE',
      normalBalance: 'CREDIT',
      parentCode: '4-0000',
    });
    await posting.post(
      {
        date: new Date('2016-03-01'),
        description: 'old-line sale',
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '750000' },
          { accountId: rev.id, credit: '750000' },
        ],
      },
      'p',
    );
    await accounts.deactivate(rev.id); // product line discontinued mid-year
    const yearEnd = new Date('2016-12-31');

    const first = await close.close(2016, 'admin');
    expect(first.status).toBe('CLOSED');
    expect(first.netIncome.toFixed(4)).toBe('750000.0000');
    expect((await balances.accountBalance(rev.id, yearEnd)).balance).toBe(
      '0.0000',
    ); // zeroed into Laba Ditahan despite being inactive

    const reopened = await close.reopen(2016, 'admin');
    expect(reopened.status).toBe('OPEN');
    const second = await close.close(2016, 'admin');
    expect(second.status).toBe('CLOSED');
    expect(second.closingEntryId).not.toBe(first.closingEntryId);
    expect((await balances.accountBalance(rev.id, yearEnd)).balance).toBe(
      '0.0000',
    );

    // Only CLOSING is exempt: an ordinary post to the inactive account fails.
    await expect(
      posting.post(
        {
          date: new Date('2007-05-01'),
          description: 'post to inactive',
          sourceType: 'MANUAL',
          createdBy: 'a',
          lines: [
            { accountId: acc['1-1000'], debit: '100' },
            { accountId: rev.id, credit: '100' },
          ],
        },
        'p',
      ),
    ).rejects.toBeInstanceOf(InvalidAccountError);
  });

  it('reopen reverses the CURRENT closing entry even if the pre-lock read was stale (re-read under the lock)', async () => {
    await app.get(PeriodsService).generatePeriods(2017);
    await posting.post(
      {
        date: new Date('2017-04-01'),
        description: 'FY2037 sale',
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '300000' },
          { accountId: acc['4-1000'], credit: '300000' },
        ],
      },
      'p',
    );
    const stale = await close.close(2017, 'admin'); // closing entry X
    await close.reopen(2017, 'admin'); // X reversed
    const current = await close.close(2017, 'admin'); // closing entry Y
    expect(current.closingEntryId).not.toBe(stale.closingEntryId);

    // Simulate a reopen whose unlocked pre-read happened before the
    // reopen + re-close above: it still sees closingEntryId = X.
    const spy = jest
      .spyOn(close, 'getStatus')
      .mockResolvedValueOnce({ ...stale, status: 'CLOSED' });
    try {
      const rec = await close.reopen(2017, 'admin');
      expect(rec.status).toBe('OPEN');
    } finally {
      spy.mockRestore();
    }
    const y = await prisma.client.journalEntry.findFirst({
      where: { id: current.closingEntryId! },
    });
    expect(y!.status).toBe('REVERSED'); // Y (current) reversed, not X again
  });

  it('POST reopen without an Idempotency-Key header returns 422 before reaching the service', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/v1/close/year-end/9999/reopen')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(422);
    expect((res.body as { message: string }).message).toContain(
      'Idempotency-Key',
    );
  });

  it('C-8: GET /v1/close/year-end/9999 for a never-closed year returns 404 NOT_FOUND', async () => {
    // C-8: ClosingController.status — no record for this year → 404
    const res = await request(app.getHttpServer() as App)
      .get('/v1/close/year-end/9999')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
    expect((res.body as { code: string }).code).toBe('NOT_FOUND');
  });

  it('refuses to close a fiscal year that has not ended yet (422 {fiscalYear, yearEnd})', async () => {
    // Next year always ends after today (WIB), whatever the run date.
    const future = new Date().getUTCFullYear() + 1;
    const { end } = await app.get(CompanyService).fiscalYearBounds(future);
    const res = await request(app.getHttpServer() as App)
      .post('/v1/close/year-end')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({ fiscalYear: future })
      .expect(422);
    const body = res.body as { code: string; details: unknown };
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.details).toEqual({
      fiscalYear: future,
      yearEnd: end.toISOString().slice(0, 10),
    });
    expect(await close.getStatus(future)).toBeNull();
  });
});
