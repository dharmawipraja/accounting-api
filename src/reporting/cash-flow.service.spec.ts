import { CashFlowService } from './cash-flow.service';
import {
  AccountBalanceRow,
  BalancesService,
} from '../ledger/balances/balances.service';

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

const make = (
  movements: AccountBalanceRow[],
  kasAwalRows: AccountBalanceRow[],
  kasAkhirRows: AccountBalanceRow[],
) =>
  new CashFlowService({
    movementsBetween: jest.fn().mockResolvedValue(movements),
    balancesAsOf: jest
      .fn()
      .mockResolvedValueOnce(kasAwalRows) // dayBefore → kasAwal
      .mockResolvedValueOnce(kasAkhirRows), // to → kasAkhir
  } as unknown as BalancesService);

const FROM = new Date('2026-01-01');
const TO = new Date('2026-12-31');

describe('CashFlowService.generate', () => {
  // Movements shared by both reconcile cases. netIncome=1000, OPERATING section=250
  // (AP 200 + NONE-category 50), INVESTING=-300, FINANCING=500 → netChange=1450.
  // The CASH-role movement (9999) must be excluded; the zero-effect row produces no line.
  const movements = [
    row({ code: 'REV', type: 'REVENUE', credit: '1000' }), // P&L → netIncome
    row({
      code: 'AP',
      type: 'LIABILITY',
      cashFlowCategory: 'OPERATING',
      credit: '200',
    }),
    row({
      code: 'EQUIP',
      type: 'ASSET',
      cashFlowCategory: 'INVESTING',
      debit: '300',
    }),
    row({
      code: 'LOAN',
      type: 'LIABILITY',
      cashFlowCategory: 'FINANCING',
      credit: '500',
    }),
    row({ code: 'ZERO', type: 'LIABILITY', cashFlowCategory: 'OPERATING' }), // zero-effect → skipped
    row({
      code: 'OTHER',
      type: 'LIABILITY',
      cashFlowCategory: 'NONE',
      credit: '50',
    }), // NONE → OPERATING
    row({ code: 'CASHMOVE', type: 'ASSET', role: 'CASH', debit: '9999' }), // excluded (role CASH)
  ];

  it('assembles the indirect statement and reconciles when kasAwal + netChange === kasAkhir', async () => {
    const svc = make(
      movements,
      [row({ code: 'KAS', role: 'CASH', debit: '100' })], // kasAwal = 100
      [row({ code: 'KAS', role: 'CASH', debit: '1550' })], // kasAkhir = 1550 = 100 + 1450
    );
    const r = await svc.generate(FROM, TO);

    expect(r.netIncome).toBe('1000.0000'); // Σ cash-effect of P&L (CASH movement excluded)
    expect(r.operating.total).toBe('1250.0000'); // netIncome 1000 + OPERATING 250
    expect(r.investing.total).toBe('-300.0000');
    expect(r.financing.total).toBe('500.0000');
    expect(r.netChange).toBe('1450.0000');
    expect(r.kasAwal).toBe('100.0000');
    expect(r.kasAkhir).toBe('1550.0000');
    expect(r.reconciles).toBe(true);
    // NONE → OPERATING, zero-effect skipped, CASH movement excluded:
    const opCodes = r.operating.adjustments.map((l) => l.code);
    expect(opCodes).toEqual(expect.arrayContaining(['AP', 'OTHER']));
    expect(opCodes).not.toContain('ZERO');
    expect(opCodes).not.toContain('CASHMOVE');
  });

  it('flags reconciles=false when the cash delta does not match netChange', async () => {
    const svc = make(
      movements,
      [row({ code: 'KAS', role: 'CASH', debit: '100' })],
      [row({ code: 'KAS', role: 'CASH', debit: '9999' })], // 9999 != 100 + 1450
    );
    const r = await svc.generate(FROM, TO);
    expect(r.reconciles).toBe(false);
  });
});
