import { IncomeStatementService } from './income-statement.service';
import {
  AccountBalanceRow,
  BalancesService,
} from '../ledger/balances/balances.service';

/** Build an AccountBalanceRow with sensible defaults; override what the case needs. */
const row = (o: Partial<AccountBalanceRow>): AccountBalanceRow => ({
  accountId: 'acc',
  code: '0',
  name: 'n',
  type: 'EXPENSE',
  subtype: 'OPERATING_EXPENSE',
  normalBalance: 'DEBIT',
  cashFlowCategory: 'OPERATING',
  role: null,
  debit: '0',
  credit: '0',
  balance: '0',
  ...o,
});

const make = (rows: AccountBalanceRow[]) =>
  new IncomeStatementService({
    movementsBetween: jest.fn().mockResolvedValue(rows),
  } as unknown as BalancesService);

describe('IncomeStatementService.generate', () => {
  it('pulls a TAX_EXPENSE-role account onto the tax line only — never double-counting it into its subtype section', async () => {
    // The seeded tax account (5-9000 Beban Pajak) carries subtype OTHER_EXPENSE, so WITHOUT the
    // role pull-out it would also land in the OTHER_EXPENSE section and double-count.
    const svc = make([
      row({
        code: '4-1000',
        name: 'Sales',
        type: 'REVENUE',
        subtype: 'REVENUE',
        credit: '1000',
      }),
      row({
        code: '5-1000',
        name: 'Rent',
        subtype: 'OPERATING_EXPENSE',
        debit: '300',
      }),
      row({
        code: '5-9000',
        name: 'Beban Pajak',
        subtype: 'OTHER_EXPENSE',
        role: 'TAX_EXPENSE',
        debit: '100',
      }),
    ]);

    const r = await svc.generate(
      new Date('2026-01-01'),
      new Date('2026-12-31'),
    );

    expect(r.taxExpense).toBe('100.0000'); // lands on the tax line
    expect(r.otherExpense).toBe('0.0000'); // the invariant: NOT double-counted into OTHER_EXPENSE
    expect(r.operatingExpense).toBe('300.0000');
    expect(r.revenue).toBe('1000.0000');
    expect(r.profitBeforeTax).toBe('700.0000'); // 1000 − 300
    expect(r.netIncome).toBe('600.0000'); // 700 − 100 tax
    // and the tax account is not smuggled into any expense section's lines
    expect(r.operatingExpenseLines.map((l) => l.code)).not.toContain('5-9000');
  });

  it('omits the tax line entirely when no TAX_EXPENSE account moved', async () => {
    const svc = make([
      row({
        code: '4-1000',
        name: 'Sales',
        type: 'REVENUE',
        subtype: 'REVENUE',
        credit: '500',
      }),
      row({
        code: '5-1000',
        name: 'Rent',
        subtype: 'OPERATING_EXPENSE',
        debit: '200',
      }),
    ]);

    const r = await svc.generate(
      new Date('2026-01-01'),
      new Date('2026-12-31'),
    );

    expect(r.taxExpense).toBe('0.0000');
    expect(r.netIncome).toBe('300.0000'); // 500 − 200, no tax
  });
});
