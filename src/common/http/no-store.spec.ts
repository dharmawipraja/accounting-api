import { isApiPath, noStoreApiResponses } from './no-store';

describe('isApiPath', () => {
  it.each(['/v1', '/v1/', '/v1/ledger/accounts', '/v1?x=1', '/v2/foo'])(
    'is an API path: %s',
    (p) => expect(isApiPath(p)).toBe(true),
  );
  it.each([
    '/health',
    '/ready',
    '/metrics',
    '/docs',
    '/docs-json',
    '/v1x',
    '/',
  ])('is not an API path: %s', (p) => expect(isApiPath(p)).toBe(false));
});

describe('noStoreApiResponses', () => {
  const run = (url: string) => {
    const headers: Record<string, string> = {};
    let called = false;
    noStoreApiResponses(
      { url },
      { setHeader: (n: string, v: string) => (headers[n] = v) },
      () => {
        called = true;
      },
    );
    return { headers, called };
  };

  it('sets Cache-Control: no-store on an API response and continues', () => {
    expect(run('/v1/auth/login')).toEqual({
      headers: { 'Cache-Control': 'no-store' },
      called: true,
    });
  });

  it('leaves a probe response alone and continues', () => {
    expect(run('/metrics')).toEqual({ headers: {}, called: true });
  });
});
