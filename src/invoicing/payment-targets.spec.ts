import { Prisma } from '@prisma/client';
import {
  paymentDateViolation,
  backdatedAllocationViolation,
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
  it('RECEIPT with an unallocated part credits the advance account', () => {
    expect(
      buildPaymentLines(PAYMENT_TARGETS.RECEIPT, 'cash', 'ar', '500.0000', {
        accountId: 'adv',
        amount: '120.0000',
      }),
    ).toEqual([
      { accountId: 'cash', debit: '500.0000' },
      { accountId: 'ar', credit: '380.0000' },
      { accountId: 'adv', credit: '120.0000' },
    ]);
  });
  it('DISBURSEMENT with zero allocations is advance/cash only', () => {
    expect(
      buildPaymentLines(
        PAYMENT_TARGETS.DISBURSEMENT,
        'cash',
        'ap',
        '500.0000',
        {
          accountId: 'adv',
          amount: '500.0000',
        },
      ),
    ).toEqual([
      { accountId: 'adv', debit: '500.0000' },
      { accountId: 'cash', credit: '500.0000' },
    ]);
  });
  it('a zero advance leaves the 2-line entry unchanged', () => {
    expect(
      buildPaymentLines(PAYMENT_TARGETS.RECEIPT, 'cash', 'ar', '500.0000', {
        accountId: 'adv',
        amount: '0.0000',
      }),
    ).toEqual([
      { accountId: 'cash', debit: '500.0000' },
      { accountId: 'ar', credit: '500.0000' },
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

describe('paymentDateViolation', () => {
  const doc = { id: 'inv-1', date: new Date('2026-05-20') };
  it('allows a payment on or after the document date', () => {
    expect(paymentDateViolation(new Date('2026-05-20'), doc)).toBeNull();
    expect(paymentDateViolation(new Date('2026-06-01'), doc)).toBeNull();
  });
  it('reports {paymentDate, documentId, documentDate} for an earlier payment', () => {
    expect(paymentDateViolation(new Date('2026-05-19'), doc)).toEqual({
      paymentDate: '2026-05-19',
      documentId: 'inv-1',
      documentDate: '2026-05-20',
    });
  });
});

describe('backdatedAllocationViolation', () => {
  const pDate = new Date('2026-03-05');
  const voided = new Date('2026-03-10');
  const base = {
    documentId: 'inv',
    paymentDate: pDate,
    total: D('100'),
    latestVoidedOn: voided,
  };
  it('null when the peak as-of paid total plus this payment fits the document total', () => {
    expect(
      backdatedAllocationViolation({
        ...base,
        peakLivePaid: D('50'),
        amount: '50',
      }),
    ).toBeNull();
  });
  it('details when the peak plus this payment exceeds the total', () => {
    expect(
      backdatedAllocationViolation({
        ...base,
        peakLivePaid: D('100'),
        amount: '0.0001',
      }),
    ).toEqual({
      documentId: 'inv',
      paymentDate: '2026-03-05',
      conflictingVoidedOn: '2026-03-10',
    });
  });
  it('null without a later-voided payment (plain over-allocation is the outstanding check)', () => {
    expect(
      backdatedAllocationViolation({
        ...base,
        latestVoidedOn: null,
        peakLivePaid: D('100'),
        amount: '1',
      }),
    ).toBeNull();
  });
});
