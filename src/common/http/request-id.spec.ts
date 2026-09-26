import { clientRequestIdOf } from './request-id';

describe('clientRequestIdOf', () => {
  it('keeps a safe inbound X-Request-Id', () => {
    expect(clientRequestIdOf('trace-abc_1.2')).toBe('trace-abc_1.2');
    expect(clientRequestIdOf('x'.repeat(128))).toBe('x'.repeat(128));
  });

  it('drops unsafe, oversized, empty, repeated or missing values', () => {
    expect(clientRequestIdOf('x'.repeat(129))).toBeNull();
    expect(clientRequestIdOf('has space')).toBeNull();
    expect(clientRequestIdOf('a/b')).toBeNull();
    expect(clientRequestIdOf('')).toBeNull();
    expect(clientRequestIdOf(['a', 'b'])).toBeNull();
    expect(clientRequestIdOf(undefined)).toBeNull();
  });
});
