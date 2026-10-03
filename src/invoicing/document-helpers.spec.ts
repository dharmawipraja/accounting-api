import { Prisma } from '@prisma/client';
import { Money } from '../common/money/money';
import {
  assertDueDateNotBefore,
  assertVoidDateNotBefore,
  nextDocumentNumber,
  normalizeVendorInvoiceNo,
  samePostableContent,
  sameTaxCalculation,
  taxableLines,
} from './document-helpers';
import { ValidationFailedError } from '../common/errors/domain-errors';
import type { TaxCalculation } from '../tax/tax.service';
import type { SqlTx } from '../common/db/sequence';

describe('taxableLines', () => {
  it('maps quantity*unitPrice to a 4dp amount and carries accountId + taxCodeIds', () => {
    const out = taxableLines([
      {
        accountId: 'acc-1',
        quantity: new Prisma.Decimal('3'),
        unitPrice: new Prisma.Decimal('1000.5'),
        taxCodeIds: ['t1'],
      },
    ]);
    expect(out).toEqual([
      { accountId: 'acc-1', amount: '3001.5000', taxCodeIds: ['t1'] },
    ]);
  });
});

describe('assertVoidDateNotBefore', () => {
  const docDate = new Date('2026-01-15');
  it('accepts the document date and any later date', () => {
    expect(() =>
      assertVoidDateNotBefore(new Date('2026-01-15'), docDate, 'd1'),
    ).not.toThrow();
    expect(() =>
      assertVoidDateNotBefore(new Date('2026-02-10'), docDate, 'd1'),
    ).not.toThrow();
  });
  it('rejects a date before the document date with VALIDATION_FAILED details', () => {
    expect(() =>
      assertVoidDateNotBefore(new Date('2026-01-14'), docDate, 'd1'),
    ).toThrow(ValidationFailedError);
    try {
      assertVoidDateNotBefore(new Date('2026-01-14'), docDate, 'd1');
    } catch (e) {
      expect((e as ValidationFailedError).details).toEqual({
        id: 'd1',
        date: '2026-01-14',
        documentDate: '2026-01-15',
      });
    }
  });
});

describe('samePostableContent', () => {
  const base = () => ({
    date: new Date('2026-03-10'),
    description: 'd' as string | null,
    lines: [
      {
        accountId: 'a1',
        quantity: new Prisma.Decimal('1'),
        unitPrice: new Prisma.Decimal('1000'),
        taxCodeIds: ['t1', 't2'],
      },
    ],
  });

  it('treats equal content (Decimal vs string, trailing zeros) as the same', () => {
    const b = base();
    b.lines[0].unitPrice = new Prisma.Decimal('1000.0000');
    expect(samePostableContent(base(), b)).toBe(true);
    expect(
      samePostableContent(
        { date: new Date('2026-03-10'), description: null },
        { date: new Date('2026-03-10'), description: null, lines: [] },
      ),
    ).toBe(true);
  });

  it.each([
    ['date', (b: ReturnType<typeof base>) => (b.date = new Date('2026-03-11'))],
    ['description', (b: ReturnType<typeof base>) => (b.description = null)],
    ['line count', (b: ReturnType<typeof base>) => b.lines.push(b.lines[0])],
    ['account', (b: ReturnType<typeof base>) => (b.lines[0].accountId = 'a2')],
    [
      'quantity',
      (b: ReturnType<typeof base>) =>
        (b.lines[0].quantity = new Prisma.Decimal('2')),
    ],
    [
      'unit price',
      (b: ReturnType<typeof base>) =>
        (b.lines[0].unitPrice = new Prisma.Decimal('1000.0001')),
    ],
    [
      'tax code order',
      (b: ReturnType<typeof base>) => (b.lines[0].taxCodeIds = ['t2', 't1']),
    ],
    [
      'tax code count',
      (b: ReturnType<typeof base>) => (b.lines[0].taxCodeIds = ['t1']),
    ],
  ])('detects a changed %s', (_name, mutate) => {
    const b = base();
    mutate(b);
    expect(samePostableContent(base(), b)).toBe(false);
  });
});

describe('assertDueDateNotBefore', () => {
  const date = new Date('2026-03-10');
  it('accepts no due date, the same day, or a later day', () => {
    expect(() => assertDueDateNotBefore(date, undefined)).not.toThrow();
    expect(() => assertDueDateNotBefore(date, null)).not.toThrow();
    expect(() =>
      assertDueDateNotBefore(date, new Date('2026-03-10')),
    ).not.toThrow();
    expect(() =>
      assertDueDateNotBefore(date, new Date('2026-04-10')),
    ).not.toThrow();
  });
  it('rejects a due date before the document date with {date, dueDate}', () => {
    expect(() => assertDueDateNotBefore(date, new Date('2026-03-09'))).toThrow(
      ValidationFailedError,
    );
    try {
      assertDueDateNotBefore(date, new Date('2026-03-09'));
    } catch (e) {
      expect((e as ValidationFailedError).details).toEqual({
        date: '2026-03-10',
        dueDate: '2026-03-09',
      });
    }
  });
});

describe('normalizeVendorInvoiceNo', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeVendorInvoiceNo('  INV-9 \t')).toBe('INV-9');
  });
  it('maps a blank value and an explicit null to null (cleared)', () => {
    expect(normalizeVendorInvoiceNo('   ')).toBeNull();
    expect(normalizeVendorInvoiceNo(null)).toBeNull();
  });
  it('keeps undefined (field omitted)', () => {
    expect(normalizeVendorInvoiceNo(undefined)).toBeUndefined();
  });
});

describe('sameTaxCalculation', () => {
  const calc = (rate = '110000.0000'): TaxCalculation => ({
    subtotal: '1000000.0000',
    taxTotal: rate,
    withholdingTotal: '0.0000',
    settlementAmount: Money.of('1000000').add(Money.of(rate)).toPersistence(),
    taxes: [
      {
        taxCodeId: 't1',
        code: 'PPN',
        kind: 'PPN_OUTPUT',
        base: '1000000.0000',
        amount: rate,
        accountId: 'tax',
      },
    ],
    journalLines: [
      { accountId: 'ar', debit: '1110000.0000' },
      { accountId: 'rev', credit: '1000000.0000' },
      { accountId: 'tax', credit: rate },
    ],
  });

  it('true for equal calculations (amount formatting ignored)', () => {
    const b = calc();
    b.subtotal = '1000000';
    expect(sameTaxCalculation(calc(), b)).toBe(true);
  });

  it('false when a tax amount / total changes (rate change)', () => {
    expect(sameTaxCalculation(calc(), calc('120000.0000'))).toBe(false);
  });

  it('false when a journal line account changes (tax account re-pointed)', () => {
    const b = calc();
    b.journalLines[2] = { ...b.journalLines[2], accountId: 'tax2' };
    expect(sameTaxCalculation(calc(), b)).toBe(false);
  });

  it('false when the breakdown length or a tax row account differs', () => {
    const b = calc();
    b.taxes = [];
    expect(sameTaxCalculation(calc(), b)).toBe(false);
    const c = calc();
    c.taxes[0] = { ...c.taxes[0], accountId: 'x' };
    expect(sameTaxCalculation(calc(), c)).toBe(false);
  });
});

describe('nextDocumentNumber', () => {
  it('locks-and-increments document_sequences keyed (document_type, fiscal_year) and builds a zero-padded ref', async () => {
    const executed: Prisma.Sql[] = [];
    const queried: Prisma.Sql[] = [];
    const tx: SqlTx = {
      $executeRaw: (q: Prisma.Sql) => {
        executed.push(q);
        return Promise.resolve(1);
      },
      $queryRaw: ((q: Prisma.Sql) => {
        queried.push(q);
        return Promise.resolve([{ next_number: 42 }]);
      }) as SqlTx['$queryRaw'],
    };

    await expect(nextDocumentNumber(tx, 'INV', 2026)).resolves.toEqual({
      number: 42,
      ref: 'INV/2026/000042',
    });
    // INSERT seeds the row if absent
    expect(executed[0].sql).toContain('document_sequences');
    expect(executed[0].sql).toContain('document_type');
    expect(executed[0].sql).toContain('ON CONFLICT');
    expect(executed[0].values).toEqual(['INV', 2026]);
    // SELECT FOR UPDATE locks the row
    expect(queried[0].sql).toContain('FOR UPDATE');
    expect(queried[0].values).toEqual(['INV', 2026]);
    // UPDATE increments to current+1
    expect(executed[1].sql).toContain('UPDATE');
    expect(executed[1].values).toEqual([43, 'INV', 2026]);
  });
});
