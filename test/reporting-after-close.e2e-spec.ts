import { INestApplication } from '@nestjs/common';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { BalanceSheetService } from '../src/reporting/balance-sheet.service';
import { CashFlowService } from '../src/reporting/cash-flow.service';
import { IncomeStatementService } from '../src/reporting/income-statement.service';
import { YearEndCloseService } from '../src/close/year-end-close.service';
import { bootstrapTestApp } from './e2e-helpers';

/**
 * Year-end CLOSING entries (and the REVERSAL a reopen posts for them) are
 * bookkeeping, not business activity: Laba Rugi, Arus Kas and the pre-closing
 * Neraca must read the same before close, after close, after reopen and after
 * re-close. OPENING entries are beginning balances, not cash flows.
 */
describe('Reporting after year-end close (e2e)', () => {
  let app: INestApplication;
  let cleanup: () => Promise<void>;
  let acc: Record<string, string>;
  let close: YearEndCloseService;

  const FROM = new Date('2006-01-01');
  const TO = new Date('2006-12-31');

  const reports = async () => ({
    is: await app.get(IncomeStatementService).generate(FROM, TO),
    cf: await app.get(CashFlowService).generate(FROM, TO),
    bs: await app.get(BalanceSheetService).generate(TO),
  });

  let before: Awaited<ReturnType<typeof reports>>;

  beforeAll(async () => {
    ({ app, cleanup } = await bootstrapTestApp({ pipe: false }));
    await app.get(CompanyService).seedIfEmpty();
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2006);
    await app.get(PeriodsService).generatePeriods(2007);
    const { data: accounts } = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    close = app.get(YearEndCloseService);
    const posting = app.get(PostingService);

    const post = (
      date: string,
      sourceType: 'MANUAL' | 'OPENING',
      debitCode: string,
      creditCode: string,
      amount: string,
    ) =>
      posting.post(
        {
          date: new Date(date),
          description: `${sourceType} ${debitCode}/${creditCode}`,
          sourceType,
          createdBy: 'a',
          lines: [
            { accountId: acc[debitCode], debit: amount },
            { accountId: acc[creditCode], credit: amount },
          ],
        },
        'p',
      );

    // Opening balance inside the report range: Dr Kas / Cr Saldo Awal 1,000,000.
    await post('2006-01-01', 'OPENING', '1-1000', '3-9000', '1000000');
    // Cash sale 2,000,000; cash expense 500,000; depreciation 100,000.
    await post('2006-02-10', 'MANUAL', '1-1000', '4-1000', '2000000');
    await post('2006-02-15', 'MANUAL', '5-2000', '1-1000', '500000');
    await post('2006-11-30', 'MANUAL', '5-4000', '1-2900', '100000');

    before = await reports();
  }, 120_000);

  afterAll(() => cleanup());

  it('before close: correct figures, OPENING is a beginning balance, depreciation is an operating add-back', () => {
    const { is, cf, bs } = before;
    expect(is.netIncome).toBe('1400000.0000');

    expect(cf.netIncome).toBe('1400000.0000');
    // OPENING is neither an operating nor a financing flow — it's in kasAwal.
    expect(cf.kasAwal).toBe('1000000.0000');
    expect(cf.kasAkhir).toBe('2500000.0000');
    expect(cf.netChange).toBe('1500000.0000');
    expect(cf.reconciles).toBe(true);
    expect(cf.financing.total).toBe('0.0000');
    expect(cf.financing.lines).toEqual([]);
    expect(cf.operating.adjustments).toEqual([
      { code: '1-2900', name: 'Akumulasi Penyusutan', amount: '100000.0000' },
    ]);
    expect(cf.operating.total).toBe('1500000.0000');
    expect(cf.investing.lines).toEqual([]);
    expect(cf.investing.total).toBe('0.0000');

    expect(bs.currentYearEarnings).toBe('1400000.0000');
    expect(bs.balanced).toBe(true);
  });

  it('after close: IS / CF / pre-closing Neraca are unchanged', async () => {
    const rec = await close.close(2006, 'admin');
    expect(rec.status).toBe('CLOSED');
    expect(rec.netIncome.toFixed(4)).toBe('1400000.0000');
    expect(await reports()).toEqual(before);
  });

  it('after close: Neraca on the first day of the next year shows the earnings in Laba Ditahan', async () => {
    const bs = await app
      .get(BalanceSheetService)
      .generate(new Date('2007-01-01'));
    const equityLines = bs.equity.groups.flatMap((g) => g.lines);
    expect(equityLines).toContainEqual({
      code: '3-2000',
      name: 'Laba Ditahan',
      amount: '1400000.0000',
    });
    expect(equityLines).toContainEqual({
      code: '',
      name: 'Laba (Rugi) Berjalan',
      amount: '0.0000',
    });
    expect(bs.currentYearEarnings).toBe('0.0000');
    expect(bs.balanced).toBe(true);
  });

  it('after reopen and re-close: reports still equal the before-close snapshot', async () => {
    await close.reopen(2006, 'admin');
    expect(await reports()).toEqual(before);
    const rec = await close.close(2006, 'admin');
    expect(await reports()).toEqual(before);
    // The report snapshot alone can't detect a wrong re-close: assert the ledger.
    expect(rec.netIncome.toFixed(4)).toBe('1400000.0000');
    const bs = await app
      .get(BalanceSheetService)
      .generate(new Date('2007-01-01'));
    expect(bs.equity.groups.flatMap((g) => g.lines)).toContainEqual({
      code: '3-2000',
      name: 'Laba Ditahan',
      amount: '1400000.0000',
    });
    expect(bs.currentYearEarnings).toBe('0.0000');
    expect(bs.balanced).toBe(true);
  });
});
