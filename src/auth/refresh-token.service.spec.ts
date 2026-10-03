import { withinReuseGrace } from './refresh-token.service';

describe('withinReuseGrace', () => {
  const consumed = new Date('2026-10-03T00:00:00.000Z');
  const t = consumed.getTime();

  it('treats a replay inside the window as a concurrent refresh', () => {
    expect(withinReuseGrace(consumed, t, 10_000)).toBe(true);
    expect(withinReuseGrace(consumed, t + 9_999, 10_000)).toBe(true);
  });

  it('treats a replay at or past the window edge as reuse', () => {
    expect(withinReuseGrace(consumed, t + 10_000, 10_000)).toBe(false);
    expect(withinReuseGrace(consumed, t + 60_000, 10_000)).toBe(false);
  });

  it('grace 0 disables it (every replay is reuse)', () => {
    expect(withinReuseGrace(consumed, t, 0)).toBe(false);
  });

  it('fails closed on a missing consumedAt', () => {
    expect(withinReuseGrace(null, t, 10_000)).toBe(false);
  });

  it('treats small clock skew (consumedAt slightly ahead) as elapsed 0', () => {
    expect(withinReuseGrace(consumed, t - 500, 10_000)).toBe(true);
    expect(withinReuseGrace(consumed, t - 500, 0)).toBe(false);
  });
});
