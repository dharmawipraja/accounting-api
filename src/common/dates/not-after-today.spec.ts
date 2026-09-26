import { ValidationFailedError } from '../errors/domain-errors';
import { assertNotAfterToday, futureDateViolation } from './not-after-today';

describe('futureDateViolation', () => {
  // WIB "today" as asOfOrToday returns it: the offset-shifted instant.
  const today = new Date('2026-09-26T20:30:00.000Z');

  it('allows a past date and today itself (any time of day)', () => {
    expect(futureDateViolation(new Date('2026-09-25'), today)).toBeNull();
    expect(futureDateViolation(new Date('2026-09-26'), today)).toBeNull();
    expect(
      futureDateViolation(new Date('2026-09-26T23:59:59Z'), today),
    ).toBeNull();
  });

  it('rejects tomorrow and later with { date, today }', () => {
    expect(futureDateViolation(new Date('2026-09-27'), today)).toEqual({
      date: '2026-09-27',
      today: '2026-09-26',
    });
    expect(futureDateViolation(new Date('2027-01-01'), today)).toEqual({
      date: '2027-01-01',
      today: '2026-09-26',
    });
  });
});

describe('assertNotAfterToday', () => {
  const today = new Date('2026-09-26T00:00:00.000Z');

  it('throws a 422 ValidationFailedError carrying { date, today }', () => {
    let err: unknown;
    try {
      assertNotAfterToday(new Date('2026-09-27'), 'Void date x', today);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ValidationFailedError);
    expect((err as ValidationFailedError).message).toBe('Void date x');
    expect((err as ValidationFailedError).details).toEqual({
      date: '2026-09-27',
      today: '2026-09-26',
    });
  });

  it('passes for today and defaults `today` to the WIB calendar day', () => {
    expect(() =>
      assertNotAfterToday(new Date('2026-09-26'), 'x', today),
    ).not.toThrow();
    expect(() =>
      assertNotAfterToday(new Date('2000-01-01'), 'x'),
    ).not.toThrow();
    expect(() => assertNotAfterToday(new Date('9999-01-01'), 'x')).toThrow(
      ValidationFailedError,
    );
  });
});
