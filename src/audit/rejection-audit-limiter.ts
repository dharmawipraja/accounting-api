/**
 * Bounds how many GUARD-REJECTION audit rows (401/403/429 written by
 * AllExceptionsFilter) a caller can cause. Anonymous 401s are rejected by
 * JwtAuthGuard BEFORE the throttler runs, so without this an attacker could
 * turn unauthenticated junk requests into unbounded audit_log INSERTs.
 *
 * Two independent key spaces, each a fixed window (`windowMs`), in-process,
 * pure (clock and reporter injected, no timers):
 *  - ANONYMOUS rejections: `limit` rows per client IP, plus a GLOBAL ceiling
 *    (`globalLimit` rows, all anonymous IPs together) so rotating source
 *    addresses (e.g. across an IPv6 /64) cannot multiply the per-IP budget.
 *    Globally suppressed rows do not consume the IP's own budget.
 *  - AUTHENTICATED rejections (403 role / password-change, 429): `userLimit`
 *    rows per user id. They never consume — and are never blocked by — the
 *    anonymous global ceiling, so an anonymous flood cannot hide an
 *    authenticated user's forbidden attempts from the audit trail.
 *
 * The anonymous global ceiling ALSO bounds anonymous rows written by
 * AuditInterceptor (`allowAnonymousGlobal`: every anonymous 4xx and every
 * anonymous 2xx except a successful login / refresh): the login throttle is
 * per IP, so rotating addresses must not multiply those rows either. Both
 * writers share ONE limiter instance (AuditModule provider).
 *
 * Suppressed rows are counted and reported ONCE per window (when that key's
 * window rolls over, is swept, or is evicted; the global count on the first
 * call after its window rolls). Memory is bounded: at most `maxKeys` keys per
 * key space; past that the oldest is evicted.
 */
/** Default total anonymous guard-rejection audit rows per window (all IPs). */
export const REJECTION_AUDIT_GLOBAL_LIMIT = 600;

export interface RejectionAuditLimiterOptions {
  /** Anonymous rows per client IP per window (default 60). */
  limit?: number;
  /** Anonymous rows per window across all IPs (default 600). */
  globalLimit?: number;
  /** Authenticated rows per user per window (default 60). */
  userLimit?: number;
  windowMs?: number;
  maxKeys?: number;
  now?: () => number;
  /** `key` is the client IP, or `user:<id>` for an authenticated bucket. */
  onSuppressed?: (key: string, suppressed: number) => void;
  onGlobalSuppressed?: (suppressed: number) => void;
}

interface Bucket {
  windowStart: number;
  count: number;
  suppressed: number;
}

/** A bounded map of fixed-window buckets (one key space). */
class KeyedWindows {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep: number;

  constructor(
    private readonly windowMs: number,
    private readonly maxKeys: number,
    private readonly report: (key: string, suppressed: number) => void,
    start: number,
  ) {
    this.lastSweep = start;
  }

  get size(): number {
    return this.buckets.size;
  }

  /** The key's live bucket (created / rolled over as needed). */
  bucket(key: string, now: number): Bucket {
    if (now - this.lastSweep >= this.windowMs) this.sweep(now);
    let bucket = this.buckets.get(key);
    if (bucket && now - bucket.windowStart >= this.windowMs) {
      this.retire(key, bucket);
      bucket = undefined;
    }
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.evictOldest();
      bucket = { windowStart: now, count: 0, suppressed: 0 };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private sweep(now: number): void {
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.windowMs) this.retire(key, bucket);
    }
  }

  private evictOldest(): void {
    const oldest = this.buckets.entries().next();
    if (!oldest.done) this.retire(oldest.value[0], oldest.value[1]);
  }

  private retire(key: string, bucket: Bucket): void {
    this.buckets.delete(key);
    if (bucket.suppressed > 0) this.report(key, bucket.suppressed);
  }
}

export class RejectionAuditLimiter {
  private readonly limit: number;
  private readonly userLimit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly globalLimit: number;
  private readonly onGlobalSuppressed: (suppressed: number) => void;
  private readonly ips: KeyedWindows;
  private readonly users: KeyedWindows;
  private readonly global: Bucket;

  constructor(opts: RejectionAuditLimiterOptions = {}) {
    this.limit = opts.limit ?? 60;
    this.userLimit = opts.userLimit ?? 60;
    this.windowMs = opts.windowMs ?? 60_000;
    const maxKeys = opts.maxKeys ?? 10_000;
    this.now = opts.now ?? Date.now;
    const onSuppressed = opts.onSuppressed ?? (() => undefined);
    this.globalLimit = opts.globalLimit ?? REJECTION_AUDIT_GLOBAL_LIMIT;
    this.onGlobalSuppressed = opts.onGlobalSuppressed ?? (() => undefined);
    const start = this.now();
    this.ips = new KeyedWindows(this.windowMs, maxKeys, onSuppressed, start);
    this.users = new KeyedWindows(this.windowMs, maxKeys, onSuppressed, start);
    this.global = { windowStart: start, count: 0, suppressed: 0 };
  }

  /** Live buckets across both key spaces. */
  get size(): number {
    return this.ips.size + this.users.size;
  }

  /** True if a rejection row may be written now. `userId` (the verified
   *  `req.user.id`) selects the per-user bucket; otherwise the per-IP bucket
   *  plus the anonymous global ceiling apply. */
  allow(ip: string, userId?: string | null): boolean {
    const now = this.now();
    if (userId) {
      const bucket = this.users.bucket(`user:${userId}`, now);
      if (bucket.count >= this.userLimit) {
        bucket.suppressed++;
        return false;
      }
      bucket.count++;
      return true;
    }

    this.rollGlobal(now);
    const bucket = this.ips.bucket(ip, now);
    if (bucket.count >= this.limit) {
      bucket.suppressed++;
      return false;
    }
    if (this.global.count >= this.globalLimit) {
      this.global.suppressed++;
      return false;
    }
    bucket.count++;
    this.global.count++;
    return true;
  }

  /** True if an ANONYMOUS interceptor-written row (a login / refresh / logout
   *  2xx or 4xx) may be written now: only the anonymous GLOBAL ceiling applies (the
   *  routes carry their own per-IP throttles). Consumes the same budget as
   *  anonymous guard rejections. */
  allowAnonymousGlobal(): boolean {
    this.rollGlobal(this.now());
    if (this.global.count >= this.globalLimit) {
      this.global.suppressed++;
      return false;
    }
    this.global.count++;
    return true;
  }

  private rollGlobal(now: number): void {
    if (now - this.global.windowStart < this.windowMs) return;
    if (this.global.suppressed > 0)
      this.onGlobalSuppressed(this.global.suppressed);
    this.global.windowStart = now;
    this.global.count = 0;
    this.global.suppressed = 0;
  }
}

/** A limiter that reports suppressed rows through `logger.warn` — the shared
 *  instance (AuditModule) and AllExceptionsFilter's fallback. */
export function loggingRejectionAuditLimiter(
  logger: { warn(message: string): unknown },
  opts: Omit<
    RejectionAuditLimiterOptions,
    'onSuppressed' | 'onGlobalSuppressed'
  > = {},
): RejectionAuditLimiter {
  return new RejectionAuditLimiter({
    ...opts,
    onSuppressed: (key, n) =>
      logger.warn(
        `Suppressed ${n} rejection audit row(s) from ${key} (per-caller cap)`,
      ),
    onGlobalSuppressed: (n) =>
      logger.warn(
        `Suppressed ${n} anonymous rejection audit row(s) across all IPs (global cap)`,
      ),
  });
}
