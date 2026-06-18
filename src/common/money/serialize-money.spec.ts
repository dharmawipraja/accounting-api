// src/common/money/serialize-money.spec.ts
import { Prisma } from '@prisma/client';
import { serializeMoney } from './serialize-money';

describe('serializeMoney', () => {
  it('renders named string fields to fixed 4dp', () => {
    const out = serializeMoney({ id: 'x', amount: '10.5', other: 7 }, [
      'amount',
    ]);
    expect(out).toEqual({ id: 'x', amount: '10.5000', other: 7 });
  });

  it('renders Prisma.Decimal fields to fixed 4dp', () => {
    const out = serializeMoney({ total: new Prisma.Decimal('1234.5') }, [
      'total',
    ]);
    expect(out.total as unknown as string).toBe('1234.5000');
  });

  it('passes through null/undefined named fields untouched', () => {
    const out = serializeMoney({ a: null as string | null }, ['a']);
    expect(out.a).toBeNull();
  });

  it('does not mutate the input object', () => {
    const input = { amount: '1' };
    serializeMoney(input, ['amount']);
    expect(input.amount).toBe('1');
  });
});
