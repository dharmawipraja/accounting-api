import request from 'supertest';
import { type App } from 'supertest/types';
import { INestApplication } from '@nestjs/common';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { YearEndCloseService } from '../src/close/year-end-close.service';
import { bootstrapTestApp } from './e2e-helpers';

interface Line {
  code: string;
  name: string;
  amount: string;
}
interface VLine {
  subtype?: string;
  code: string;
  current: string;
  comparative: string;
  variance: string;
}
type Body = Record<string, unknown>;

const sum = (xs: string[]) => xs.reduce((s, x) => s + Number(x), 0);

/**
 * Pre-closing trial balance, per-account other income / other expense / tax
 * lines on the Laba Rugi, and comparative Laba Rugi / Neraca.
 * FY2008: opening 10,000,000; sale 2,000,000; opex 500,000; other income
 * 100,000; other expense 40,000; tax 60,000 → net 1,500,000.
 * FY2009: sale 3,000,000; other income 50,000; opex 200,000 → net 2,850,000.
 */
describe('Reporting: pre-closing TB, other/tax lines, comparatives (e2e)', () => {
  let app: INestApplication;
  let cleanup: () => Promise<void>;
  let token: string;

  const get = (url: string, status = 200) =>
    request(app.getHttpServer() as App)
      .get(url)
      .set('Authorization', `Bearer ${token}`)
      .expect(status)
      .then((r) => r.body as Body);

  beforeAll(async () => {
    ({ app, cleanup } = await bootstrapTestApp());
    await app.get(CompanyService).seedIfEmpty();
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2008);
    await app.get(PeriodsService).generatePeriods(2009);
    await app.get(UsersService).create({
      email: 'v@cmp.test',
      password: 'secret123',
      name: 'V',
      role: 'VIEWER',
    });
    token = (await app.get(AuthService).login('v@cmp.test', 'secret123'))
      .accessToken;
    const { data: accounts } = await app.get(AccountsService).list();
    const acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    const posting = app.get(PostingService);
    const post = (
      date: string,
      dr: string,
      cr: string,
      amount: string,
      sourceType: 'MANUAL' | 'OPENING' = 'MANUAL',
    ) =>
      posting.post(
        {
          date: new Date(date),
          description: `${dr}/${cr}`,
          sourceType,
          createdBy: 'a',
          lines: [
            { accountId: acc[dr], debit: amount },
            { accountId: acc[cr], credit: amount },
          ],
        },
        'p',
      );
    await post('2008-01-01', '1-1000', '3-1000', '10000000', 'OPENING');
    await post('2008-02-10', '1-1000', '4-1000', '2000000');
    await post('2008-02-15', '5-2000', '1-1000', '500000');
    await post('2008-03-01', '1-1000', '4-9000', '100000');
    await post('2008-04-01', '5-9100', '1-1000', '40000');
    await post('2008-12-20', '5-9000', '1-1000', '60000');
    await post('2009-02-10', '1-1000', '4-1000', '3000000');
    await post('2009-03-01', '1-1000', '4-9000', '50000');
    await post('2009-05-01', '5-3000', '1-1000', '200000');
  }, 120_000);

  afterAll(() => cleanup());

  it('pre-closing trial balance at a closed year-end equals the pre-close TB and shows P&L balances', async () => {
    const tb = (q = '') => get(`/v1/ledger/trial-balance?asOf=2008-12-31${q}`);
    const preClose = await tb();
    // Before any close the flag changes nothing.
    expect(await tb('&preClosing=true')).toEqual(preClose);

    await app.get(YearEndCloseService).close(2008, 'admin');

    const post = await tb(); // default: post-closing ledger view
    const pre = await tb('&preClosing=true');
    expect(pre).toEqual(preClose);
    const row = (b: Body, code: string) =>
      (b.rows as { code: string; balance: string }[]).find(
        (r) => r.code === code,
      );
    expect(row(pre, '4-1000')?.balance).toBe('2000000.0000');
    expect(row(pre, '5-9000')?.balance).toBe('60000.0000');
    expect(row(post, '4-1000')?.balance).toBe('0.0000'); // closed into Laba Ditahan
    expect(row(post, '3-2000')?.balance).toBe('1500000.0000');
    expect(row(pre, '3-2000')).toBeUndefined();
    for (const b of [pre, post]) expect(b.totalDebit).toBe(b.totalCredit);
    // explicit false = default
    expect(await tb('&preClosing=false')).toEqual(post);
  });

  it('Laba Rugi lists other income / other expense / tax per account, summing to the totals', async () => {
    const is = await get(
      '/v1/reports/income-statement?from=2008-01-01&to=2008-12-31',
    );
    const lines = (k: string) => is[k] as Line[];
    expect(lines('otherIncomeLines')).toEqual([
      { code: '4-9000', name: 'Pendapatan Lain-lain', amount: '100000.0000' },
    ]);
    expect(lines('otherExpenseLines').map((l) => [l.code, l.amount])).toEqual([
      ['5-9100', '40000.0000'],
    ]);
    expect(lines('taxExpenseLines').map((l) => [l.code, l.amount])).toEqual([
      ['5-9000', '60000.0000'],
    ]);
    for (const [k, total] of [
      ['otherIncomeLines', 'otherIncome'],
      ['otherExpenseLines', 'otherExpense'],
      ['taxExpenseLines', 'taxExpense'],
      ['revenueLines', 'revenue'],
    ])
      expect(sum(lines(k).map((l) => l.amount))).toBe(Number(is[total]));
    expect(is.netIncome).toBe('1500000.0000');
    expect(is.comparative).toBeUndefined();
    expect(is.variance).toBeUndefined();
  });

  it('comparative Laba Rugi equals the comparison period run separately; variance = current − comparative', async () => {
    const cur = await get(
      '/v1/reports/income-statement?from=2009-01-01&to=2009-12-31',
    );
    const cmp = await get(
      '/v1/reports/income-statement?from=2008-01-01&to=2008-12-31',
    );
    const both = await get(
      '/v1/reports/income-statement?from=2009-01-01&to=2009-12-31&compareFrom=2008-01-01&compareTo=2008-12-31',
    );
    const { comparative, variance, ...main } = both;
    expect(main).toEqual(cur);
    expect(comparative).toEqual(cmp);
    const v = variance as Record<string, unknown>;
    expect(cur.netIncome).toBe('2850000.0000');
    expect(v.netIncome).toBe('1350000.0000');
    for (const k of ['revenue', 'otherIncome', 'taxExpense', 'grossProfit'])
      expect(Number(v[k])).toBe(Number(cur[k]) - Number(cmp[k]));
    // Accounts in only one period: tax/other expense (2008) and 5-3000 (2009).
    expect(v.taxExpenseLines).toEqual([
      {
        code: '5-9000',
        name: 'Beban Pajak',
        current: '0.0000',
        comparative: '60000.0000',
        variance: '-60000.0000',
      },
    ]);
    const opex = v.operatingExpenseLines as VLine[];
    expect(opex.map((l) => [l.code, l.variance])).toEqual([
      ['5-3000', '200000.0000'],
      ['5-2000', '-500000.0000'],
    ]);
    // line variances sum to the section variance
    for (const [k, total] of [
      ['revenueLines', 'revenue'],
      ['operatingExpenseLines', 'operatingExpense'],
      ['otherIncomeLines', 'otherIncome'],
    ])
      expect(sum((v[k] as VLine[]).map((l) => l.variance))).toBe(
        Number(v[total]),
      );
  });

  it('comparative Neraca equals the comparison date run separately; both balance and tie', async () => {
    const cur = await get('/v1/reports/balance-sheet?asOf=2009-12-31');
    const cmp = await get('/v1/reports/balance-sheet?asOf=2008-12-31');
    const both = await get(
      '/v1/reports/balance-sheet?asOf=2009-12-31&compareAsOf=2008-12-31',
    );
    const { comparative, variance, ...main } = both;
    expect(main).toEqual(cur);
    expect(comparative).toEqual(cmp);
    expect(cur.balanced).toBe(true);
    expect(cmp.balanced).toBe(true);
    // 2008 Neraca is pre-closing: its current earnings tie to the 2008 Laba Rugi.
    expect(cmp.currentYearEarnings).toBe('1500000.0000');
    expect(cur.currentYearEarnings).toBe('2850000.0000');
    const v = variance as Record<string, unknown>;
    expect(v.totalAssets).toBe('2850000.0000');
    expect(v.currentYearEarnings).toBe('1350000.0000');
    for (const [k, total] of [
      ['assets', 'totalAssets'],
      ['liabilities', 'totalLiabilities'],
      ['equity', 'totalEquity'],
    ])
      expect(sum((v[k] as VLine[]).map((l) => l.variance))).toBe(
        Number(v[total]),
      );
    // Laba Ditahan: 1,500,000 in 2009 (FY2008 closed), absent on 2008-12-31.
    expect(
      (v.equity as VLine[]).find((l) => l.code === '3-2000'),
    ).toMatchObject({
      subtype: 'EQUITY',
      current: '1500000.0000',
      comparative: '0.0000',
    });
  });

  it('validates the new query params', async () => {
    await get(
      '/v1/reports/income-statement?from=2009-01-01&to=2009-12-31&compareFrom=2008-01-01',
      422,
    );
    await get(
      '/v1/reports/income-statement?from=2009-01-01&to=2009-12-31&compareFrom=2008-12-31&compareTo=2008-01-01',
      422,
    );
    await get(
      '/v1/reports/income-statement?from=2009-01-01&to=2009-12-31&compareFrom=2008-1-01&compareTo=2008-12-31',
      400,
    );
    await get('/v1/reports/balance-sheet?compareAsOf=2008-02-30', 400);
    await get('/v1/ledger/trial-balance?preClosing=yes', 400);
  });
});
