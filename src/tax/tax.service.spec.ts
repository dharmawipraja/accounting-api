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
});
