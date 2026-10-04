/**
 * Bounds how many audit rows a caller can cause where nothing else bounds them:
 * GUARD-REJECTION rows (401/403/429 written by AllExceptionsFilter — anonymous
 * 401s are rejected by JwtAuthGuard BEFORE the throttler runs) and every
 * ANONYMOUS row AuditInterceptor writes. Without it an attacker could turn
 * unauthenticated junk requests into unbounded audit_log INSERTs.
 *
 * One fixed-window key space (`windowMs`), in-process, pure (clock and
 * reporter injected, no timers), `limit` rows per key per window:
 *  - an ANONYMOUS row is keyed by client IP, and also counts against a GLOBAL
 *    ceiling (`globalLimit` rows, all anonymous IPs together) so rotating
 *    source addresses (e.g. across an IPv6 /64) cannot multiply the per-IP
 *    budget. Globally suppressed rows do not consume the IP's own budget.
 *  - a row with a verified user (`req.user.id`, or the owner of the access
 *    token a successful login / refresh just issued) is keyed `user:<id>` and
 *    never consumes — nor is blocked by — the global ceiling, so an anonymous
 *    flood cannot hide an authenticated user's forbidden attempts or a
 *    successful login / refresh from the audit trail.
 *
 * Both writers share ONE limiter instance (AuditModule provider). Suppressed
 * rows are counted and reported ONCE per window (when that key's window rolls
 * over, is swept, or is evicted; the global count on the first call after its
 * window rolls). Memory is bounded: at most `maxKeys` keys; past that the
 * oldest is evicted.
 */
/** Default total anonymous audit rows per window (all IPs). */
const REJECTION_AUDIT_GLOBAL_LIMIT = 600;

interface RejectionAuditLimiterOptions {
  /** Rows per key (client IP, or user) per window (default 60). */
  limit?: number;
  /** Anonymous rows per window across all IPs (default 600). */
  globalLimit?: number;
  windowMs?: number;
  maxKeys?: number;
  now?: () => number;
  /** `key` is the client IP, or `user:<id>` for a user bucket. */
  onSuppressed?: (key: string, suppressed: number) => void;
  onGlobalSuppressed?: (suppressed: number) => void;
}

interface Bucket {
  windowStart: number;
  count: number;
  suppressed: number;
}

export class RejectionAuditLimiter {
  private readonly limit: number;
  private readonly globalLimit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly onSuppressed: (key: string, suppressed: number) => void;
  private readonly onGlobalSuppressed: (suppressed: number) => void;
  private readonly buckets = new Map<string, Bucket>();
  private readonly global: Bucket;
  private lastSweep: number;

  constructor(opts: RejectionAuditLimiterOptions = {}) {
    this.limit = opts.limit ?? 60;
    this.globalLimit = opts.globalLimit ?? REJECTION_AUDIT_GLOBAL_LIMIT;
    this.windowMs = opts.windowMs ?? 60_000;
    this.maxKeys = opts.maxKeys ?? 10_000;
    this.now = opts.now ?? Date.now;
    this.onSuppressed = opts.onSuppressed ?? (() => undefined);
    this.onGlobalSuppressed = opts.onGlobalSuppressed ?? (() => undefined);
    this.lastSweep = this.now();
    this.global = { windowStart: this.lastSweep, count: 0, suppressed: 0 };
  }

  /** Live buckets. */
  get size(): number {
    return this.buckets.size;
  }

  /** True if an audit row may be written now. `userId` (verified) selects the
   *  per-user bucket; otherwise the per-IP bucket plus the global ceiling. */
  allow(ip: string, userId?: string | null): boolean {
    const now = this.now();
    const bucket = this.bucket(userId ? `user:${userId}` : ip, now);
    if (bucket.count >= this.limit) {
      bucket.suppressed++;
      return false;
    }
    if (!userId) {
      this.rollGlobal(now);
      if (this.global.count >= this.globalLimit) {
        this.global.suppressed++;
        return false;
      }
      this.global.count++;
    }
    bucket.count++;
    return true;
  }

  /** The key's live bucket (created / rolled over as needed). */
  private bucket(key: string, now: number): Bucket {
    if (now - this.lastSweep >= this.windowMs) this.sweep(now);
    let bucket = this.buckets.get(key);
    if (bucket && now - bucket.windowStart >= this.windowMs) {
      this.retire(key, bucket);
      bucket = undefined;
    }
    if (!bucket) {
      const oldest = this.buckets.entries().next();
      if (this.buckets.size >= this.maxKeys && !oldest.done) {
        this.retire(oldest.value[0], oldest.value[1]);
      }
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

  private retire(key: string, bucket: Bucket): void {
    this.buckets.delete(key);
    if (bucket.suppressed > 0) this.onSuppressed(key, bucket.suppressed);
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
      logger.warn(`Suppressed ${n} audit row(s) from ${key} (per-caller cap)`),
    onGlobalSuppressed: (n) =>
      logger.warn(
        `Suppressed ${n} anonymous audit row(s) across all IPs (global cap)`,
      ),
  });
}
