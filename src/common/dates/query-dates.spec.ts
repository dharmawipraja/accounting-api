import { ValidationFailedError } from '../errors/domain-errors';
import { asOfOrToday, dateRange, optionalDateRange } from './query-dates';

describe('asOfOrToday', () => {
  it('parses a provided as-of string', () => {
    expect(asOfOrToday('2026-03-15').toISOString()).toBe(
      '2026-03-15T00:00:00.000Z',
    );
  });
  it('defaults to a valid Date (today) when absent', () => {
    const d = asOfOrToday(undefined);
    expect(d).toBeInstanceOf(Date);
    expect(Number.isNaN(d.getTime())).toBe(false);
  });
  it('resolves "today" in the report timezone (WIB), not the UTC day', () => {
    // 2026-06-30T21:00Z is 2026-07-01 04:00 in WIB (UTC+7): the report day
    // must be July 1 even though the UTC calendar still says June 30.
    const d = asOfOrToday(undefined, new Date('2026-06-30T21:00:00Z'));
    expect(d.toISOString().slice(0, 10)).toBe('2026-07-01');
  });
  it('rolls to the next WIB day during the late-UTC evening', () => {
    // 2026-07-01T18:00Z is 2026-07-02 01:00 WIB.
    const d = asOfOrToday(undefined, new Date('2026-07-01T18:00:00Z'));
    expect(d.toISOString().slice(0, 10)).toBe('2026-07-02');
  });
  it('an explicit asOf is untouched by the timezone default', () => {
    const d = asOfOrToday('2026-03-15', new Date('2026-07-01T18:00:00Z'));
    expect(d.toISOString()).toBe('2026-03-15T00:00:00.000Z');
  });
});

describe('dateRange', () => {
  it('returns both dates when ordered', () => {
    const { from, to } = dateRange('2026-01-01', '2026-12-31');
    expect(from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-12-31T00:00:00.000Z');
  });
  it('throws ValidationFailedError when from > to', () => {
    expect(() => dateRange('2026-12-31', '2026-01-01')).toThrow(
      ValidationFailedError,
    );
    expect(() => dateRange('2026-12-31', '2026-01-01')).toThrow(
      '`from` must be on or before `to`',
    );
  });
  it('allows from === to (equal boundary)', () => {
    const { from, to } = dateRange('2026-01-01', '2026-01-01');
    expect(from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
  it('accepts a span exactly at the maxDays bound', () => {
    const { from, to } = dateRange('2026-01-01', '2027-01-02', 366);
    expect(from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(to.toISOString()).toBe('2027-01-02T00:00:00.000Z');
  });
  it('throws ValidationFailedError when the span exceeds maxDays', () => {
    expect(() => dateRange('2026-01-01', '2027-01-03', 366)).toThrow(
      ValidationFailedError,
    );
    expect(() => dateRange('2016-01-01', '2026-12-31', 366)).toThrow(
      '366 days',
    );
  });
});

describe('optionalDateRange', () => {
  it('returns undefineds when both absent', () => {
    expect(optionalDateRange(undefined, undefined)).toEqual({
      from: undefined,
      to: undefined,
    });
  });
  it('returns one bound without throwing when only one present', () => {
    expect(optionalDateRange('2026-01-01', undefined).from?.toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    expect(optionalDateRange(undefined, '2026-12-31').to?.toISOString()).toBe(
      '2026-12-31T00:00:00.000Z',
    );
  });
  it('throws when both present and from > to', () => {
    expect(() => optionalDateRange('2026-12-31', '2026-01-01')).toThrow(
      ValidationFailedError,
    );
  });
});
