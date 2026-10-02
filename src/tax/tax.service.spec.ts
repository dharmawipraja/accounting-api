import { TaxService } from './tax.service';
import { ValidationFailedError } from '../common/errors/domain-errors';

const CODES = [
  {
    id: 'ppn-out',
    code: 'PPN-OUT',
    kind: 'PPN_OUTPUT',
    rate: '0.11',
    taxAccountId: 'acc-ppn-out',
    isActive: true,
  },
  {
    id: 'ppn-in',
    code: 'PPN-IN',
    kind: 'PPN_INPUT',
    rate: '0.11',
    taxAccountId: 'acc-ppn-in',
    isActive: true,
  },
  {
    id: 'pph-pay',
    code: 'PPH-PAY',
    kind: 'PPH_PAYABLE',
    rate: '0.02',
    taxAccountId: 'acc-pph',
    isActive: true,
  },
  {
    id: 'pph-pre',
    code: 'PPH-PRE',
    kind: 'PPH_PREPAID',
    rate: '0.02',
    taxAccountId: 'acc-pph-pre',
    isActive: true,
  },
  {
    id: 'pph42-pay',
    code: 'PPH42-PAY',
    kind: 'PPH_PAYABLE',
    rate: '0.10',
    taxAccountId: 'acc-pph42',
    isActive: true,
  },
  {
    id: 'inactive',
    code: 'OLD',
    kind: 'PPN_OUTPUT',
    rate: '0.11',
    taxAccountId: 'acc-x',
    isActive: false,
  },
];

const make = (subset = CODES) =>
  new TaxService({
    client: {
      companySettings: {
        findFirst: jest.fn().mockResolvedValue({ isPkp: true }),
      },
      taxCode: {
        findMany: jest
          .fn()
          .mockImplementation(
            ({ where }: { where: { id: { in: string[] } } }) =>
              Promise.resolve(subset.filter((c) => where.id.in.includes(c.id))),
          ),
      },
    },
  } as never);

describe('TaxService.calculate', () => {
  it('SALE with PPN output: settlement = subtotal + PPN, balanced', async () => {
    const r = await make().calculate({
      nature: 'SALE',
      settlementAccountId: 'ar',
      lines: [{ accountId: 'rev', amount: '1000000', taxCodeIds: ['ppn-out'] }],
    });
    expect(r.subtotal).toBe('1000000.0000');
    expect(r.taxes).toHaveLength(1);
    expect(r.taxes[0].amount).toBe('110000.0000'); // 1,000,000 * 0.11
    expect(r.settlementAmount).toBe('1110000.0000');
    expect(r.taxTotal).toBe('110000.0000'); // PPN only
    expect(r.withholdingTotal).toBe('0.0000');
    const dr = r.journalLines.reduce((s, l) => s + Number(l.debit ?? 0), 0);
    const cr = r.journalLines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
    expect(dr).toBeCloseTo(cr); // balanced
  });

  it('PURCHASE with PPN input + PPh withholding: settlement = subtotal + PPN − PPh', async () => {
    const r = await make().calculate({
      nature: 'PURCHASE',
      settlementAccountId: 'ap',
      lines: [
        {
          accountId: 'exp',
          amount: '1000000',
          taxCodeIds: ['ppn-in', 'pph-pay'],
        },
      ],
    });
    // PPN 110,000 ; PPh 20,000 → settlement 1,090,000
    expect(r.settlementAmount).toBe('1090000.0000');
    expect(r.taxTotal).toBe('110000.0000'); // PPN bucket
    expect(r.withholdingTotal).toBe('20000.0000'); // PPh bucket
  });

  it('rounds each tax code to whole rupiah once', async () => {
    const r = await make().calculate({
      nature: 'SALE',
      settlementAccountId: 'ar',
      lines: [{ accountId: 'rev', amount: '333333', taxCodeIds: ['ppn-out'] }],
    });
    // 333,333 * 0.11 = 36,666.63 → rounds to 36,667
    expect(r.taxes[0].amount).toBe('36667.0000');
  });

  it('rounds base x rate ONCE to rupiah (no intermediate 4dp rounding)', async () => {
    const r = await make().calculate({
      nature: 'SALE',
      settlementAccountId: 'ar',
      lines: [
        { accountId: 'rev', amount: '100004.5450', taxCodeIds: ['ppn-out'] },
      ],
    });
    // 100,004.5450 * 0.11 = 11,000.49995 → 11,000 (a 4dp pre-round would
    // give 11,000.5000 → 11,001).
    expect(r.taxes[0].amount).toBe('11000.0000');
  });

  it('rejects PPN Input on a PURCHASE for a non-PKP company (422)', async () => {
    const svc = new TaxService({
      client: {
        companySettings: {
          findFirst: jest.fn().mockResolvedValue({ isPkp: false }),
        },
        taxCode: { findMany: jest.fn().mockResolvedValue([CODES[1]]) },
      },
    } as never);
    await expect(
      svc.calculate({
        nature: 'PURCHASE',
        settlementAccountId: 'ap',
        lines: [{ accountId: 'exp', amount: '1000', taxCodeIds: ['ppn-in'] }],
      }),
    ).rejects.toThrow(/PPN Input can only be credited by a PKP company/);
  });

  it('allows PPh withholding on a PURCHASE for a non-PKP company', async () => {
    const svc = new TaxService({
      client: {
        companySettings: {
          findFirst: jest.fn().mockResolvedValue({ isPkp: false }),
        },
        taxCode: { findMany: jest.fn().mockResolvedValue([CODES[2]]) },
      },
    } as never);
    const r = await svc.calculate({
      nature: 'PURCHASE',
      settlementAccountId: 'ap',
      lines: [{ accountId: 'exp', amount: '1000', taxCodeIds: ['pph-pay'] }],
    });
    expect(r.withholdingTotal).toBe('20.0000');
  });

  it('rejects a duplicate tax code within one line (422)', async () => {
    await expect(
      make().calculate({
        nature: 'SALE',
        settlementAccountId: 'ar',
        lines: [
          {
            accountId: 'rev',
            amount: '100',
            taxCodeIds: ['ppn-out', 'ppn-out'],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('rejects two PPh codes stacked on one line (422)', async () => {
    await expect(
      make().calculate({
        nature: 'PURCHASE',
        settlementAccountId: 'ap',
        lines: [
          {
            accountId: 'exp',
            amount: '1000000',
            taxCodeIds: ['ppn-in', 'pph-pay', 'pph42-pay'],
          },
        ],
      }),
    ).rejects.toThrow('at most one PPN code and one PPh code');
  });

  it('allows different PPh codes on different lines', async () => {
    const r = await make().calculate({
      nature: 'PURCHASE',
      settlementAccountId: 'ap',
      lines: [
        { accountId: 'exp', amount: '1000000', taxCodeIds: ['pph-pay'] },
        { accountId: 'rent', amount: '1000000', taxCodeIds: ['pph42-pay'] },
      ],
    });
    expect(r.withholdingTotal).toBe('120000.0000');
  });

  it('rejects an unknown tax code (422)', async () => {
    await expect(
      make([]).calculate({
        nature: 'SALE',
        settlementAccountId: 'ar',
        lines: [{ accountId: 'rev', amount: '100', taxCodeIds: ['nope'] }],
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('rejects an inactive tax code (422)', async () => {
    await expect(
      make().calculate({
        nature: 'SALE',
        settlementAccountId: 'ar',
        lines: [{ accountId: 'rev', amount: '100', taxCodeIds: ['inactive'] }],
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('rejects a tax kind not allowed for the nature (422)', async () => {
    await expect(
      make().calculate({
        nature: 'SALE',
        settlementAccountId: 'ar',
        lines: [{ accountId: 'rev', amount: '100', taxCodeIds: ['ppn-in'] }],
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('rejects when withholding leaves a non-positive settlement (422)', async () => {
    // subtotal 100, no PPN, PPh rate that exceeds gross → use a big-rate code via override
    const big = [
      {
        id: 'pph-big',
        code: 'PPH-BIG',
        kind: 'PPH_PAYABLE',
        rate: '1.5',
        taxAccountId: 'acc',
        isActive: true,
      },
    ];
    await expect(
      make(big).calculate({
        nature: 'PURCHASE',
        settlementAccountId: 'ap',
        lines: [{ accountId: 'exp', amount: '100', taxCodeIds: ['pph-big'] }],
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('rejects empty lines (422)', async () => {
    await expect(
      make().calculate({
        nature: 'SALE',
        settlementAccountId: 'ar',
        lines: [],
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('drops zero-amount journal lines (free item) but keeps it in the subtotal base', async () => {
    const r = await make().calculate({
      nature: 'SALE',
      settlementAccountId: 'ar',
      lines: [
        { accountId: 'rev', amount: '1000', taxCodeIds: ['ppn-out'] },
        { accountId: 'rev-free', amount: '0', taxCodeIds: [] },
      ],
    });
    expect(r.journalLines.map((l) => l.accountId)).toEqual([
      'rev',
      'acc-ppn-out',
      'ar',
    ]);
    expect(r.settlementAmount).toBe('1110.0000');
  });

  it('drops a tax line whose amount rounds to zero', async () => {
    const r = await make().calculate({
      nature: 'SALE',
      settlementAccountId: 'ar',
      lines: [
        { accountId: 'rev', amount: '1000', taxCodeIds: [] },
        { accountId: 'rev-free', amount: '0', taxCodeIds: ['ppn-out'] },
      ],
    });
    expect(r.journalLines.map((l) => l.accountId)).toEqual(['rev', 'ar']);
    expect(r.taxes[0].amount).toBe('0.0000'); // still reported in the breakdown
  });

  it('rejects a zero-total document with a total-specific message (422)', async () => {
    await expect(
      make().calculate({
        nature: 'SALE',
        settlementAccountId: 'ar',
        lines: [{ accountId: 'rev', amount: '0', taxCodeIds: ['ppn-out'] }],
      }),
    ).rejects.toThrow('Document total must be greater than zero');
  });
});
