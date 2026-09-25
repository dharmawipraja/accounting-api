import { Prisma } from '@prisma/client';
import { assertVoidDateNotBefore, taxableLines } from './document-helpers';
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
