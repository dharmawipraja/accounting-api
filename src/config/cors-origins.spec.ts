import { parseCorsOrigins } from './cors-origins';

describe('parseCorsOrigins', () => {
  it('returns false when unset (CORS disabled — fail-closed)', () => {
    expect(parseCorsOrigins(undefined)).toBe(false);
  });
  it('returns false for an empty / whitespace-only value', () => {
    expect(parseCorsOrigins('')).toBe(false);
    expect(parseCorsOrigins('  ,  ')).toBe(false);
  });
  it('splits, trims, and drops empties', () => {
    expect(parseCorsOrigins('https://a.com, https://b.com ,')).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
  });
});
