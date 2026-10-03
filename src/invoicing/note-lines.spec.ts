import { Prisma } from '@prisma/client';
import {
  noteJournalLines,
  returnedLine,
  splitSettlement,
  OriginalLine,
} from './note-lines';
import { lineAmounts } from './document-helpers';

const D = (v: string) => new Prisma.Decimal(v);

const orig = (over: Partial<OriginalLine> = {}): OriginalLine => ({
  id: 'l1',
  description: 'Barang',
  accountId: 'rev',
  quantity: D('3'),
  unitPrice: D('100000'),
  discountPercent: null,
  discountAmount: D('0'),
  taxCodeIds: ['ppn'],
  ...over,
});

describe('returnedLine', () => {
  it('copies description, account, unit price and tax codes', () => {
    expect(returnedLine(orig(), '1')).toEqual({
      originalLineId: 'l1',
      description: 'Barang',
      accountId: 'rev',
      quantity: '1',
      unitPrice: '100000',
      discountPercent: null,
      discountAmount: '0.0000',
      taxCodeIds: ['ppn'],
    });
  });

  it('keeps a percent discount as the same percent', () => {
    const l = returnedLine(
      orig({ discountPercent: D('10'), discountAmount: D('30000') }),
      '2',
    );
    expect(l).toMatchObject({ discountPercent: '10', discountAmount: null });
    expect(lineAmounts(l)).toEqual({
      discountPercent: '10',
      discountAmount: '20000.0000',
      amount: '180000.0000',
    });
  });

  it('pro-rates a fixed discount by quantity, rounded once to 4dp half-up', () => {
    // 100 × 1/3 = 33.3333…  → 33.3333
    expect(
      returnedLine(orig({ discountAmount: D('100') }), '1').discountAmount,
    ).toBe('33.3333');
    // 0.0005 × 1/2 = 0.00025 → 0.0003 (half-up)
    expect(
      returnedLine(
        orig({
          quantity: D('2'),
          unitPrice: D('1'),
          discountAmount: D('0.0005'),
        }),
        '1',
      ).discountAmount,
    ).toBe('0.0003');
    // a full return gives back exactly the original discount
    expect(
      returnedLine(orig({ discountAmount: D('100') }), '3').discountAmount,
    ).toBe('100.0000');
  });

  it('caps the pro-rated discount at the returned gross (defensive)', () => {
    // An original whose discount exceeds its gross cannot be stored (CHECK),
    // but the cap keeps a returned line valid whatever the rounding.
    expect(
      returnedLine(
        orig({ quantity: D('2'), unitPrice: D('1'), discountAmount: D('5') }),
        '1',
      ).discountAmount,
    ).toBe('1.0000');
  });
});

describe('splitSettlement', () => {
  it('applies to the original up to its outstanding, the rest is excess', () => {
    expect(splitSettlement('111000', '500000')).toEqual({
      applied: '111000.0000',
      excess: '0.0000',
    });
    expect(splitSettlement('111000', '11000')).toEqual({
      applied: '11000.0000',
      excess: '100000.0000',
    });
    expect(splitSettlement('111000', '0')).toEqual({
      applied: '0.0000',
      excess: '111000.0000',
    });
  });
});

describe('noteJournalLines', () => {
  // Sales invoice journal for the returned part: Cr revenue, Cr PPN, Dr PPh
  // prepaid, Dr AR (settlement, last).
  const sale = [
    { accountId: 'rev', credit: '100000.0000' },
    { accountId: 'ppn', credit: '11000.0000' },
    { accountId: 'pph', debit: '2000.0000' },
    { accountId: 'ar', debit: '109000.0000' },
  ];

  it('mirrors every line; the settlement credits AR', () => {
    expect(
      noteJournalLines(sale, 'ar', { applied: '109000', excess: '0' }),
    ).toEqual([
      { accountId: 'rev', debit: '100000.0000' },
      { accountId: 'ppn', debit: '11000.0000' },
      { accountId: 'pph', credit: '2000.0000' },
      { accountId: 'ar', credit: '109000' },
    ]);
  });

  it('splits the settlement between AR and the advance account', () => {
    expect(
      noteJournalLines(sale, 'ar', {
        applied: '9000',
        excess: '100000',
        advanceAccountId: 'adv',
      }).slice(-2),
    ).toEqual([
      { accountId: 'ar', credit: '9000' },
      { accountId: 'adv', credit: '100000' },
    ]);
    expect(
      noteJournalLines(sale, 'ar', {
        applied: '0',
        excess: '109000',
        advanceAccountId: 'adv',
      }).slice(-1),
    ).toEqual([{ accountId: 'adv', credit: '109000' }]);
  });

  it('purchase: debits AP (and the vendor advance) and credits expense / PPN', () => {
    const bill = [
      { accountId: 'exp', debit: '100000.0000' },
      { accountId: 'ppn-in', debit: '11000.0000' },
      { accountId: 'pph-pay', credit: '2000.0000' },
      { accountId: 'ap', credit: '109000.0000' },
    ];
    expect(
      noteJournalLines(bill, 'ap', {
        applied: '9000',
        excess: '100000',
        advanceAccountId: 'va',
      }),
    ).toEqual([
      { accountId: 'exp', credit: '100000.0000' },
      { accountId: 'ppn-in', credit: '11000.0000' },
      { accountId: 'pph-pay', debit: '2000.0000' },
      { accountId: 'ap', debit: '9000' },
      { accountId: 'va', debit: '100000' },
    ]);
  });

  it('refuses a journal without the trailing settlement line', () => {
    expect(() =>
      noteJournalLines(sale.slice(0, -1), 'ar', { applied: '1', excess: '0' }),
    ).toThrow(/settlement/);
  });
});
