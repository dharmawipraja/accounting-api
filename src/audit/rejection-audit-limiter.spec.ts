import { RejectionAuditLimiter } from './rejection-audit-limiter';

function setup(
  opts: {
    limit?: number;
    maxKeys?: number;
    globalLimit?: number;
  } = {},
) {
  let t = 1_000_000;
  const reports: [string, number][] = [];
  const globalReports: number[] = [];
  const limiter = new RejectionAuditLimiter({
    limit: opts.limit ?? 3,
    globalLimit: opts.globalLimit,
    windowMs: 60_000,
    maxKeys: opts.maxKeys ?? 10_000,
    now: () => t,
    onSuppressed: (ip, n) => reports.push([ip, n]),
    onGlobalSuppressed: (n) => globalReports.push(n),
  });
  return {
    limiter,
    reports,
    globalReports,
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

  it('caps total rows across ALL IPs per window (IP rotation cannot bypass the per-IP cap)', () => {
    const { limiter, globalReports, advance } = setup({
      limit: 3,
      globalLimit: 5,
    });
    const results = Array.from({ length: 10 }, (_, i) =>
      limiter.allow(`2001:db8::${i}`),
    );
    expect(results).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(globalReports).toEqual([]); // reported once, when the window rolls
    advance(60_000);
    expect(limiter.allow('2001:db8::99')).toBe(true);
    expect(globalReports).toEqual([5]);
    advance(60_000);
    limiter.allow('2001:db8::98');
    expect(globalReports).toEqual([5]); // nothing suppressed last window
  });

  it("a globally suppressed request does not consume that IP's own budget", () => {
    const { limiter, advance } = setup({ limit: 2, globalLimit: 1 });
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('b')).toBe(false); // global cap
    advance(60_000);
    expect(limiter.allow('b')).toBe(true);
  });

  it('defaults the global ceiling to 600 rows per window', () => {
    const { limiter } = setup({ limit: 1_000_000, globalLimit: undefined });
    let allowed = 0;
    for (let i = 0; i < 700; i++) if (limiter.allow(`ip${i}`)) allowed++;
    expect(allowed).toBe(600);
  });

  it('user rows use a per-user bucket (same limit), not the IP one', () => {
    const { limiter, reports, advance } = setup({ limit: 60 });
    let allowed = 0;
    for (let i = 0; i < 70; i++) if (limiter.allow('1.1.1.1', 'u1')) allowed++;
    expect(allowed).toBe(60);
    // same IP, anonymous: its own IP budget is untouched by u1's rows
    expect(limiter.allow('1.1.1.1')).toBe(true);
    // another user behind the same IP has a fresh budget
    expect(limiter.allow('1.1.1.1', 'u2')).toBe(true);
    advance(60_000);
    expect(limiter.allow('1.1.1.1', 'u1')).toBe(true);
    expect(reports).toContainEqual(['user:u1', 10]);
  });

  it('user rows are never blocked by, nor consume, the anonymous global ceiling', () => {
    const { limiter } = setup({ limit: 100, globalLimit: 2 });
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('b')).toBe(true);
    expect(limiter.allow('c')).toBe(false); // anonymous global cap reached
    // a user row (authenticated rejection, or a successful login / refresh
    // keyed to its token owner) is still audited
    expect(limiter.allow('c', 'u1')).toBe(true);
    // and a fresh window's anonymous budget is not eaten by user rows
    const { limiter: l2 } = setup({ limit: 100, globalLimit: 2 });
    for (let i = 0; i < 5; i++) l2.allow('x', 'u1');
    expect(l2.allow('a')).toBe(true);
    expect(l2.allow('b')).toBe(true);
  });

  it('a null / empty user id falls back to the IP bucket + global ceiling', () => {
    const { limiter } = setup({ limit: 100, globalLimit: 1 });
    expect(limiter.allow('a', null)).toBe(true);
    expect(limiter.allow('b', '')).toBe(false);
  });
});
