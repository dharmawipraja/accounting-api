import { Prisma } from '@prisma/client';
import { taxableLines } from './document-helpers';

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
