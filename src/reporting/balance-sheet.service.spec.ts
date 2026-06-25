import { BalanceSheetService } from './balance-sheet.service';
import {
  AccountBalanceRow,
  BalancesService,
} from '../ledger/balances/balances.service';
import { CompanyService } from '../company/company.service';

const row = (o: Partial<AccountBalanceRow>): AccountBalanceRow => ({
  accountId: 'a',
  code: '0',
  name: 'n',
  type: 'ASSET',
  subtype: 'CURRENT_ASSET',
  normalBalance: 'DEBIT',
  cashFlowCategory: 'OPERATING',
  role: null,
  debit: '0',
  credit: '0',
  balance: '0',
  ...o,
});

const make = (asOfRows: AccountBalanceRow[], fyRows: AccountBalanceRow[]) =>
  new BalanceSheetService(
    {
      balancesAsOf: jest.fn().mockResolvedValue(asOfRows),
      movementsBetween: jest.fn().mockResolvedValue(fyRows),
    } as unknown as BalancesService,
    {
      fiscalYearFor: jest.fn().mockResolvedValue(2026),
      fiscalYearBounds: jest.fn().mockResolvedValue({
        start: new Date('2026-01-01'),
        end: new Date('2026-12-31'),
      }),
    } as unknown as CompanyService,
  );

const AS_OF = new Date('2026-06-30');

describe('BalanceSheetService.generate', () => {
  it('assembles A/L/E with a contra-asset, synthetic earnings, and balances', async () => {
    // assets: cash 1300 + Akumulasi (contra, credit 300 → -300) = 1000
    // liabilities: AP 400 ; equity capital 500
    // cumulative earnings: REV(credit 200) + EXP(debit 100 → -100) = 100 → totalEquity = 600
    // balanced: 1000 === 400 + 600
    const asOfRows = [
      row({
        code: 'KAS',
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        debit: '1300',
      }),
      row({
        code: 'AKUM',
        type: 'ASSET',
        subtype: 'FIXED_ASSET',
        credit: '300',
      }), // contra → -300
      row({
        code: 'AP',
        type: 'LIABILITY',
        subtype: 'CURRENT_LIABILITY',
        credit: '400',
      }),
      row({ code: 'CAP', type: 'EQUITY', subtype: 'CAPITAL', credit: '500' }),
      row({ code: 'REV', type: 'REVENUE', subtype: 'REVENUE', credit: '200' }),
      row({
        code: 'EXP',
        type: 'EXPENSE',
        subtype: 'OPERATING_EXPENSE',
        debit: '100',
      }),
    ];
    // current-FY earnings is a SEPARATE figure from movementsBetween (credit−debit
    // over P&L only): REV 80 − EXP 30 = 50; the ASSET row is filtered out.
    const fyRows = [
      row({ code: 'REV', type: 'REVENUE', credit: '80' }),
      row({ code: 'EXP', type: 'EXPENSE', debit: '30' }),
      row({ code: 'KAS', type: 'ASSET', debit: '999' }), // non-P&L → excluded
    ];

    const svc = make(asOfRows, fyRows);
    const r = await svc.generate(AS_OF);

    expect(r.totalAssets).toBe('1000.0000'); // 1300 − 300 contra
    expect(r.totalLiabilities).toBe('400.0000');
    expect(r.totalEquity).toBe('600.0000'); // capital 500 + cumulative earnings 100
    expect(r.currentYearEarnings).toBe('50.0000'); // REV 80 − EXP 30, from movementsBetween (not cumulative 100)
    expect(r.balanced).toBe(true);
    // the synthetic CURRENT_EARNINGS equity group carries the cumulative figure:
    const ce = r.equity.groups.find((g) => g.subtype === 'CURRENT_EARNINGS');
    expect(ce?.subtotal).toBe('100.0000');
    // the contra asset reads negative in its group line:
    const akum = r.assets.groups
      .flatMap((g) => g.lines)
      .find((l) => l.code === 'AKUM');
    expect(akum?.amount).toBe('-300.0000');
  });

  it('flags balanced=false when assets != liabilities + equity', async () => {
    // drop the contra → assets 1300, but L+E still 1000 → unbalanced
    const asOfRows = [
      row({ code: 'KAS', type: 'ASSET', debit: '1300' }),
      row({ code: 'AP', type: 'LIABILITY', credit: '400' }),
      row({ code: 'CAP', type: 'EQUITY', credit: '500' }),
      row({ code: 'REV', type: 'REVENUE', credit: '200' }),
      row({ code: 'EXP', type: 'EXPENSE', debit: '100' }),
    ];
    const svc = make(asOfRows, []);
    const r = await svc.generate(AS_OF);
    expect(r.totalAssets).toBe('1300.0000');
    expect(r.balanced).toBe(false);
  });
});
