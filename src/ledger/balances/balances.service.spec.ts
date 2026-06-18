import { Prisma } from '@prisma/client';
import { BalancesService } from './balances.service';

const rawRow = (over: Partial<Record<string, unknown>>) => ({
  account_id: 'id',
  code: '1-1000',
  name: 'X',
  type: 'ASSET',
  subtype: 'CURRENT_ASSET',
  normal_balance: 'DEBIT',
  cash_flow_category: 'OPERATING',
  role: null,
  debit: new Prisma.Decimal('0'),
  credit: new Prisma.Decimal('0'),
  ...over,
});

const make = (rows: unknown[]) =>
  new BalancesService(
    { $queryRaw: jest.fn().mockResolvedValue(rows) } as never,
    {} as never,
  );

describe('BalancesService signing (toRow via balancesAsOf)', () => {
  it('DEBIT-normal account: balance = debit − credit', async () => {
    const [r] = await make([
      rawRow({
        normal_balance: 'DEBIT',
        debit: new Prisma.Decimal('100'),
        credit: new Prisma.Decimal('30'),
      }),
    ]).balancesAsOf(new Date('2026-06-30'));
    expect(r.balance).toBe('70.0000');
    expect(r.debit).toBe('100.0000');
    expect(r.credit).toBe('30.0000');
  });

  it('CREDIT-normal account: balance = credit − debit', async () => {
    const [r] = await make([
      rawRow({
        code: '3-1000',
        type: 'EQUITY',
        normal_balance: 'CREDIT',
        debit: new Prisma.Decimal('30'),
        credit: new Prisma.Decimal('100'),
      }),
    ]).balancesAsOf(new Date('2026-06-30'));
    expect(r.balance).toBe('70.0000');
  });

  it('carries metadata (role, type, cashFlowCategory) through unchanged', async () => {
    const [r] = await make([rawRow({ role: 'CASH' })]).balancesAsOf(
      new Date('2026-06-30'),
    );
    expect(r.role).toBe('CASH');
    expect(r.type).toBe('ASSET');
    expect(r.cashFlowCategory).toBe('OPERATING');
  });
});
