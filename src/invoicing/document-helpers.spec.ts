import { Prisma } from '@prisma/client';
import {
  taxableLines,
  AR_CONTROL_CODE,
  AP_CONTROL_CODE,
} from './document-helpers';

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

describe('control-account constants', () => {
  it('pins AR/AP control codes', () => {
    expect(AR_CONTROL_CODE).toBe('1-1200');
    expect(AP_CONTROL_CODE).toBe('2-1000');
  });
});
