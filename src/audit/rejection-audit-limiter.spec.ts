import { RejectionAuditLimiter } from './rejection-audit-limiter';

function setup(opts: { limit?: number; maxKeys?: number } = {}) {
  let t = 1_000_000;
  const reports: [string, number][] = [];
  const limiter = new RejectionAuditLimiter({
    limit: opts.limit ?? 3,
    windowMs: 60_000,
    maxKeys: opts.maxKeys ?? 10_000,
    now: () => t,
    onSuppressed: (ip, n) => reports.push([ip, n]),
  });
  return {
    limiter,
    reports,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('RejectionAuditLimiter', () => {
  it('allows up to `limit` rows per IP per window, then suppresses', () => {
    const { limiter } = setup();
    expect([1, 2, 3, 4, 5].map(() => limiter.allow('1.1.1.1'))).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    // other IPs have their own budget
    expect(limiter.allow('2.2.2.2')).toBe(true);
  });

  it('reports the suppressed count once when the window rolls over, then resets', () => {
    const { limiter, reports, advance } = setup();
    for (let i = 0; i < 5; i++) limiter.allow('1.1.1.1');
    expect(reports).toEqual([]);
    advance(60_000);
    expect(limiter.allow('1.1.1.1')).toBe(true);
    expect(reports).toEqual([['1.1.1.1', 2]]);
    advance(60_000);
    limiter.allow('1.1.1.1');
    expect(reports).toHaveLength(1); // nothing suppressed in the last window
  });

  it('sweeps expired keys (reporting their suppressed counts) on a later call', () => {
    const { limiter, reports, advance } = setup();
    for (let i = 0; i < 4; i++) limiter.allow('9.9.9.9');
    advance(61_000);
    limiter.allow('8.8.8.8'); // triggers the periodic sweep
    expect(reports).toEqual([['9.9.9.9', 1]]);
    expect(limiter.size).toBe(1);
  });

  it('bounds memory: evicts the oldest key past maxKeys', () => {
    const { limiter, reports } = setup({ limit: 1, maxKeys: 2 });
    limiter.allow('a');
    limiter.allow('a'); // suppressed
    limiter.allow('b');
    limiter.allow('c'); // evicts 'a'
    expect(limiter.size).toBe(2);
    expect(reports).toEqual([['a', 1]]);
    expect(limiter.allow('a')).toBe(true); // fresh budget after eviction
  });
});
