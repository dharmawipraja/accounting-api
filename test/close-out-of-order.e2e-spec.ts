import { INestApplication } from '@nestjs/common';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { BalancesService } from '../src/ledger/balances/balances.service';
import { YearEndCloseService } from '../src/close/year-end-close.service';
import { bootstrapTestApp } from './e2e-helpers';

/**
 * P0-2: net income for a close must be that year's OWN P&L movement, not the
 * cumulative all-history balance. Closing years out of order (FY2007 before
 * FY2006) must still attribute each year only its own earnings — otherwise the
 * earlier year is swept twice into Laba Ditahan.
 *
 * 2006 net income = 2,000,000 − 500,000 = 1,500,000
 * 2007 net income = 3,000,000 − 1,000,000 = 2,000,000
 */
describe('Year-end close — out-of-order close (e2e)', () => {
  let app: INestApplication;
  let cleanup: () => Promise<void>;
  let acc: Record<string, string>;
  let posting: PostingService;
  let balances: BalancesService;
  let close: YearEndCloseService;

  const plNet = async (asOf: string): Promise<number> => {
    const rows = await balances.balancesAsOf(new Date(asOf));
    return rows
      .filter((r) => r.type === 'REVENUE' || r.type === 'EXPENSE')
      .reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0);
  };

  beforeAll(async () => {
    ({ app, cleanup } = await bootstrapTestApp({ pipe: false }));
    await app.get(CompanyService).seedIfEmpty();
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2006);
    await app.get(PeriodsService).generatePeriods(2007);
    const { data: accounts } = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    posting = app.get(PostingService);
    balances = app.get(BalancesService);
    close = app.get(YearEndCloseService);

    const post = (
      date: string,
      debitAcc: string,
      creditAcc: string,
      amt: string,
    ) =>
      posting.post(
        {
          date: new Date(date),
          description: `${date} entry`,
          sourceType: 'MANUAL',
          createdBy: 'a',
          lines: [
            { accountId: acc[debitAcc], debit: amt },
            { accountId: acc[creditAcc], credit: amt },
          ],
        },
        'p',
      );

    // 2006 P&L
    await post('2006-02-10', '1-1000', '4-1000', '2000000'); // revenue
    await post('2006-02-15', '5-2000', '1-1000', '500000'); // expense
    // 2007 P&L
    await post('2007-03-10', '1-1000', '4-1000', '3000000'); // revenue
    await post('2007-03-15', '5-2000', '1-1000', '1000000'); // expense
  }, 120_000);

  afterAll(() => cleanup());

  it('closing FY2007 before FY2006 attributes each year only its own net income', async () => {
    // Close the LATER year first — the out-of-order case.
    const rec2007 = await close.close(2007, 'admin');
    expect(rec2007.netIncome.toFixed(4)).toBe('2000000.0000'); // 2007 only, not 3,500,000 cumulative

    const rec2006 = await close.close(2006, 'admin');
    expect(rec2006.netIncome.toFixed(4)).toBe('1500000.0000');

    // Laba Ditahan holds the sum of both years' earnings — counted once each.
    const ret = await balances.accountBalance(
      acc['3-2000'],
      new Date('2007-12-31'),
    );
    expect(ret.balance).toBe('3500000.0000'); // 1,500,000 + 2,000,000

    // All P&L accounts are zeroed as of the later year-end.
    expect(await plNet('2007-12-31')).toBe(0);
  });
});
