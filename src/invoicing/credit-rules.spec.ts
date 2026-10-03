import { Prisma } from '@prisma/client';
import { Money } from '../common/money/money';
import { ValidationFailedError } from '../common/errors/domain-errors';
import {
  assertCreditUsable,
  assertWithinUnapplied,
} from './credit-application';
import { presentApplications } from './document-presenter';

const source = { noun: 'payment', dateKey: 'paymentDate' };
const holder = {
  id: 'p1',
  status: 'POSTED' as const,
  date: new Date('2026-03-10'),
};

const thrown = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    return e as ValidationFailedError;
  }
  throw new Error('expected a throw');
};

describe('credit rules (apply / refund)', () => {
  it('refuses a non-POSTED holder with the use-specific verb', () => {
    const e = thrown(() =>
      assertCreditUsable(
        source,
        { ...holder, status: 'DRAFT' },
        holder.date,
        'refund',
      ),
    );
    expect(e).toBeInstanceOf(ValidationFailedError);
    expect(e.message).toBe('Only a POSTED payment can be refunded');
    expect(
      thrown(() =>
        assertCreditUsable(
          source,
          { ...holder, status: 'VOID' },
          holder.date,
          'application',
        ),
      ).message,
    ).toBe('Only a POSTED payment can be applied');
  });

  it('date must be on/after the holder date (same day ok)', () => {
    expect(() =>
      assertCreditUsable(source, holder, holder.date, 'refund'),
    ).not.toThrow();
    const e = thrown(() =>
      assertCreditUsable(source, holder, new Date('2026-03-09'), 'refund'),
    );
    expect(e.message).toBe('Refund date cannot be before the payment date');
    expect(e.details).toEqual({
      id: 'p1',
      date: '2026-03-09',
      paymentDate: '2026-03-10',
    });
  });

  it('caps the requested amount at the unapplied balance (exact fit ok)', () => {
    expect(() =>
      assertWithinUnapplied(source, 'p1', '100', Money.of('100'), 'refund'),
    ).not.toThrow();
    const e = thrown(() =>
      assertWithinUnapplied(
        source,
        'p1',
        '100',
        Money.of('100.0001'),
        'refund',
      ),
    );
    expect(e.message).toBe('Refund exceeds the payment unapplied amount');
    expect(e.details).toEqual({
      id: 'p1',
      unappliedAmount: '100.0000',
      requested: '100.0001',
    });
    expect(
      thrown(() =>
        assertWithinUnapplied(source, 'p1', '0', Money.of('1'), 'application'),
      ).message,
    ).toBe('Application exceeds the payment unapplied amount');
  });

  it('splits rows into applications (document target) and refunds (cash target), 4dp', () => {
    const row = (id: string, cashAccountId: string | null) => ({
      id,
      cashAccountId,
      amount: new Prisma.Decimal('5'),
    });
    const out = presentApplications([
      row('a', null),
      row('r', 'kas'),
      row('b', null),
    ]);
    expect(out.applications.map((a) => a.id)).toEqual(['a', 'b']);
    expect(out.refunds).toEqual([
      { id: 'r', cashAccountId: 'kas', amount: '5.0000' },
    ]);
  });
});
