import {
  corsOptions,
  parseCorsOrigins,
  productionCorsViolations,
} from './cors-origins';

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
  it('exposes Retry-After and the Coretax export headers to browser clients', () => {
    expect(corsOptions('https://a.com')).toEqual({
      origin: ['https://a.com'],
      exposedHeaders: [
        'Retry-After',
        'Content-Disposition',
        'X-Coretax-Invoice-Count',
      ],
    });
  });
  it('stays fail-closed (origin false) when CORS_ORIGIN is unset', () => {
    expect(corsOptions(undefined).origin).toBe(false);
  });
});

describe('productionCorsViolations', () => {
  it('accepts unset / empty (CORS off) and public https origins', () => {
    expect(productionCorsViolations(undefined)).toEqual([]);
    expect(productionCorsViolations('')).toEqual([]);
    expect(
      productionCorsViolations(
        'https://app.example.com, https://admin.example.com:8443',
      ),
    ).toEqual([]);
  });
  it.each([
    ['*'],
    ['http://localhost:5173'],
    ['https://localhost'],
    ['https://app.localhost'],
    ['https://127.0.0.1'],
    ['https://127.1.2.3:8443'],
    ['https://[::1]'],
    ['https://0.0.0.0'],
    ['http://app.example.com'],
    ['app.example.com'],
    ['https://app.example.com/path'],
    ['https://app.example.com?x=1'],
    ['https://user@app.example.com'],
    ['https://app.example.com/'],
    ['https://App.Example.com'],
  ])('rejects %s', (raw) => {
    expect(productionCorsViolations(raw)).toEqual([raw]);
  });
  it('names only the offending entries', () => {
    expect(
      productionCorsViolations('https://app.example.com,http://localhost:5173'),
    ).toEqual(['http://localhost:5173']);
  });
});
