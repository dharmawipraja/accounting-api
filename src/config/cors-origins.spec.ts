import { corsOptions, parseCorsOrigins } from './cors-origins';

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

describe('corsOptions', () => {
  it('exposes Retry-After so a browser client can read the 429 back-off', () => {
    expect(corsOptions('https://a.com')).toEqual({
      origin: ['https://a.com'],
      exposedHeaders: ['Retry-After'],
    });
  });
  it('stays fail-closed (origin false) when CORS_ORIGIN is unset', () => {
    expect(corsOptions(undefined).origin).toBe(false);
  });
});
