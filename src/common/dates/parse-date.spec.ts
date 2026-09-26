import { isAuditInstantString, parseDate } from './parse-date';

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

describe('isAuditInstantString (strict audit-filter instant)', () => {
  it.each([
    '2026-01-15',
    '1970-01-01',
    '9999-12-31',
    '2024-02-29',
    '2026-06-25T10:00',
    '2026-06-25T10:00:00Z',
    '2026-06-25T10:00:00.123Z',
    '2026-06-25T23:59:59.999+07:00',
    '2026-06-25T00:00:00-0530',
  ])('accepts %s', (v) => {
    expect(isAuditInstantString(v)).toBe(true);
  });

  it.each([
    '0000-01-01',
    '1969-12-31',
    '2026-02-30',
    '2025-02-29',
    '2026-04-31T10:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T10:60:00Z',
    '2026-01-01T10:00:61Z',
    '2026-01-01T10:00:00+25:00',
    '2026-W01',
    '2026-032',
    '20260101',
    '+012026-01-01',
    '2026-01-01 10:00',
    '',
  ])('rejects %j', (v) => {
    expect(isAuditInstantString(v)).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isAuditInstantString(20260101)).toBe(false);
    expect(isAuditInstantString(undefined)).toBe(false);
  });
});
