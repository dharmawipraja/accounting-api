import { parseDate } from './parse-date';

describe('parseDate', () => {
  it('returns undefined for undefined input', () => {
    expect(parseDate(undefined)).toBeUndefined();
  });

  it('returns undefined for null input', () => {
    expect(parseDate(null)).toBeUndefined();
  });

  it('returns undefined for empty string input', () => {
    // An empty string is falsy, so the ternary short-circuits to undefined.
    expect(parseDate('')).toBeUndefined();
  });

  it('parses a valid ISO date string into a Date', () => {
    const d = parseDate('2026-01-15');
    expect(d).toBeInstanceOf(Date);
    expect(d?.toISOString().slice(0, 10)).toBe('2026-01-15');
  });

  it('parses an ISO datetime string into a Date', () => {
    const d = parseDate('2026-06-25T10:00:00.000Z');
    expect(d).toBeInstanceOf(Date);
    expect(d?.toISOString()).toBe('2026-06-25T10:00:00.000Z');
  });
});
