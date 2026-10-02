import { ValidationFailedError } from '../errors/domain-errors';
import {
  businessDate,
  isBusinessDateString,
  optionalBusinessDate,
  patchBusinessDate,
} from './business-date';

describe('businessDate', () => {
  it('maps a plain YYYY-MM-DD to UTC midnight of that day', () => {
    expect(businessDate('2026-02-28').toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });
  it('rejects a timestamp — a UTC instant can name the wrong WIB day (422)', () => {
    // toISOString() at 00:30 WIB on July 1 would otherwise post to June 30.
    expect(() => businessDate('2026-06-30T17:30:00.000Z')).toThrow(
      ValidationFailedError,
    );
    expect(() => businessDate('2026-07-01T00:30+07:00')).toThrow(
      ValidationFailedError,
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
    expect(optionalBusinessDate('2026-03-15')?.toISOString()).toBe(
      '2026-03-15T00:00:00.000Z',
    );
  });
});

describe('isBusinessDateString (DTO boundary)', () => {
  it('accepts only a real YYYY-MM-DD day, never a timestamp', () => {
    expect(isBusinessDateString('2026-02-28')).toBe(true);
    expect(isBusinessDateString('2026-07-01T00:30+07:00')).toBe(false);
    expect(isBusinessDateString('2026-07-01 ')).toBe(false);
  });
  it('rejects an ISO-shaped impossible day and non-strings', () => {
    expect(isBusinessDateString('2026-02-30')).toBe(false);
    expect(isBusinessDateString('2026-13-01')).toBe(false);
    expect(isBusinessDateString(20260228)).toBe(false);
  });
});

describe('patchBusinessDate (PATCH tri-state)', () => {
  it('keeps undefined (field omitted → unchanged)', () => {
    expect(patchBusinessDate(undefined)).toBeUndefined();
  });
  it('keeps an explicit null (field cleared)', () => {
    expect(patchBusinessDate(null)).toBeNull();
  });
  it('parses a present value as a business date', () => {
    expect(patchBusinessDate('2026-03-15')?.toISOString()).toBe(
      '2026-03-15T00:00:00.000Z',
    );
  });
});
