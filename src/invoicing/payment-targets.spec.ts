import { Prisma } from '@prisma/client';
import {
  exceedsOutstanding,
  buildPaymentLines,
  PAYMENT_TARGETS,
} from './payment-targets';

const D = (v: string) => new Prisma.Decimal(v);

describe('exceedsOutstanding', () => {
  it('false at the exact boundary (amount == outstanding)', () => {
    expect(exceedsOutstanding(D('1000'), D('0'), '1000')).toBe(false);
    expect(exceedsOutstanding(D('1000'), D('400'), '600')).toBe(false);
  });
  it('true when amount exceeds outstanding', () => {
    expect(exceedsOutstanding(D('1000'), D('0'), '1000.0001')).toBe(true);
    expect(exceedsOutstanding(D('1000'), D('400'), '700')).toBe(true);
  });
  it('false when well under', () => {
    expect(exceedsOutstanding(D('1000'), D('0'), '1')).toBe(false);
  });
});

describe('buildPaymentLines', () => {
  it('RECEIPT debits cash, credits control', () => {
    expect(
      buildPaymentLines(PAYMENT_TARGETS.RECEIPT, 'cash', 'ar', '500.0000'),
    ).toEqual([
      { accountId: 'cash', debit: '500.0000' },
      { accountId: 'ar', credit: '500.0000' },
    ]);
  });
  it('DISBURSEMENT debits control, credits cash', () => {
    expect(
      buildPaymentLines(PAYMENT_TARGETS.DISBURSEMENT, 'cash', 'ap', '500.0000'),
    ).toEqual([
      { accountId: 'ap', debit: '500.0000' },
      { accountId: 'cash', credit: '500.0000' },
    ]);
  });
});
