import { resolveTrustProxy } from './trust-proxy';

describe('resolveTrustProxy', () => {
  it('defaults to 1 hop in production (Caddy -> api)', () => {
    expect(resolveTrustProxy({ NODE_ENV: 'production' })).toBe(1);
  });

  it('defaults to 0 (trust nothing) outside production', () => {
    expect(resolveTrustProxy({ NODE_ENV: 'development' })).toBe(0);
    expect(resolveTrustProxy({ NODE_ENV: 'test' })).toBe(0);
    expect(resolveTrustProxy({})).toBe(0);
  });

  it('honours an explicit TRUST_PROXY_HOPS in any env', () => {
    expect(
      resolveTrustProxy({ NODE_ENV: 'production', TRUST_PROXY_HOPS: '2' }),
    ).toBe(2);
    expect(
      resolveTrustProxy({ NODE_ENV: 'production', TRUST_PROXY_HOPS: '0' }),
    ).toBe(0);
    expect(
      resolveTrustProxy({ NODE_ENV: 'development', TRUST_PROXY_HOPS: '1' }),
    ).toBe(1);
  });
});
