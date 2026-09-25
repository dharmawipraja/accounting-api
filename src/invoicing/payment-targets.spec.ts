import { Prisma } from '@prisma/client';
import {
  exceedsOutstanding,
  buildPaymentLines,
  inLockOrder,
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

describe('inLockOrder', () => {
  it('orders allocations by target id so opposite input orders lock identically', () => {
    const t = PAYMENT_TARGETS.RECEIPT;
    const a = { salesInvoiceId: 'aaa', amount: '1' };
    const b = { salesInvoiceId: 'bbb', amount: '2' };
    expect(inLockOrder(t, [b, a])).toEqual([a, b]);
    expect(inLockOrder(t, [a, b])).toEqual([a, b]);
  });
  it('is stable for repeated allocations to one document and does not mutate input', () => {
    const t = PAYMENT_TARGETS.DISBURSEMENT;
    const x1 = { purchaseBillId: 'x', amount: '1' };
    const x2 = { purchaseBillId: 'x', amount: '2' };
    const w = { purchaseBillId: 'w', amount: '3' };
    const input = [x1, w, x2];
    expect(inLockOrder(t, input)).toEqual([w, x1, x2]);
    expect(input).toEqual([x1, w, x2]);
  });
});
