import { ValidationFailedError } from '../errors/domain-errors';
import {
  businessDate,
  isBusinessDateString,
  optionalBusinessDate,
} from './business-date';

describe('businessDate', () => {
  it('takes the calendar date from the first 10 chars, ignoring the offset', () => {
    // 00:30 WIB is still the previous day in UTC — the business date must not
    // shift back to June 30.
    expect(businessDate('2026-07-01T00:30+07:00').toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
  });
  it('does not roll forward for a late negative-offset time', () => {
    expect(businessDate('2026-07-01T23:30:00-05:00').toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
  });
  it('maps a plain YYYY-MM-DD to UTC midnight of that day', () => {
    expect(businessDate('2026-02-28').toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });
  it('rejects an impossible calendar date with a 422', () => {
    expect(() => businessDate('2026-02-30')).toThrow(ValidationFailedError);
  });
  it('rejects a string without a leading YYYY-MM-DD with a 422', () => {
    expect(() => businessDate('07/01/2026')).toThrow(ValidationFailedError);
  });
});

describe('optionalBusinessDate', () => {
  it('returns undefined for an absent value', () => {
    expect(optionalBusinessDate(undefined)).toBeUndefined();
    expect(optionalBusinessDate(null)).toBeUndefined();
    expect(optionalBusinessDate('')).toBeUndefined();
  });
  it('parses a present value as a business date', () => {
    expect(optionalBusinessDate('2026-03-15T22:00:00Z')?.toISOString()).toBe(
      '2026-03-15T00:00:00.000Z',
    );
  });
});

describe('isBusinessDateString (DTO boundary)', () => {
  it('accepts a real day with or without a time/offset', () => {
    expect(isBusinessDateString('2026-02-28')).toBe(true);
    expect(isBusinessDateString('2026-07-01T00:30+07:00')).toBe(true);
  });
  it('rejects an ISO-shaped impossible day and non-strings', () => {
    expect(isBusinessDateString('2026-02-30')).toBe(false);
    expect(isBusinessDateString('2026-13-01')).toBe(false);
    expect(isBusinessDateString(20260228)).toBe(false);
  });
});
