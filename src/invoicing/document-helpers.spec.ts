import { Prisma } from '@prisma/client';
import {
  assertVoidDateNotBefore,
  samePostableContent,
  taxableLines,
} from './document-helpers';
import { ValidationFailedError } from '../common/errors/domain-errors';

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
