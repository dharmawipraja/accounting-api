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
      assertNotAfterToday(new Date('2026-09-27'), 'Void date x', { today });
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
      assertNotAfterToday(new Date('2026-09-26'), 'x', { today }),
    ).not.toThrow();
    expect(() =>
      assertNotAfterToday(new Date('2000-01-01'), 'x'),
    ).not.toThrow();
    expect(() => assertNotAfterToday(new Date('9999-01-01'), 'x')).toThrow(
      ValidationFailedError,
    );
  });
});

describe('iter6 ruling: originalDate <= date <= max(today WIB, originalDate)', () => {
  const today = new Date('2026-09-26T00:00:00.000Z');

  it('a future-dated original: its own date (and anything up to it) is accepted', () => {
    const originalDate = new Date('2026-10-15');
    expect(
      futureDateViolation(new Date('2026-10-15'), today, originalDate),
    ).toBeNull();
    expect(
      futureDateViolation(new Date('2026-10-01'), today, originalDate),
    ).toBeNull();
    expect(() =>
      assertNotAfterToday(new Date('2026-10-15'), 'x', {
        today,
        originalDate,
      }),
    ).not.toThrow();
  });

  it('a date after BOTH today and the original date → 422 { date, today, originalDate }', () => {
    const originalDate = new Date('2026-10-15');
    expect(
      futureDateViolation(new Date('2026-10-16'), today, originalDate),
    ).toEqual({
      date: '2026-10-16',
      today: '2026-09-26',
      originalDate: '2026-10-15',
    });
    expect(() =>
      assertNotAfterToday(new Date('2026-10-16'), 'x', {
        today,
        originalDate,
      }),
    ).toThrow(ValidationFailedError);
  });

  it('a past original date: the ceiling stays today (details unchanged)', () => {
    const originalDate = new Date('2026-01-10');
    expect(
      futureDateViolation(new Date('2026-09-26'), today, originalDate),
    ).toBeNull();
    expect(
      futureDateViolation(new Date('2026-09-27'), today, originalDate),
    ).toEqual({ date: '2026-09-27', today: '2026-09-26' });
  });
});
