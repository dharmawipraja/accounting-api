/**
 * Bounds how many GUARD-REJECTION audit rows (401/403/429 written by
 * AllExceptionsFilter) one client IP can cause. Anonymous 401s are rejected by
 * JwtAuthGuard BEFORE the throttler runs, so without this an attacker could
 * turn unauthenticated junk requests into unbounded audit_log INSERTs.
 *
 * Fixed window per IP (`limit` rows / `windowMs`), in-process, pure (clock and
 * reporter injected, no timers). Suppressed rows are counted and reported ONCE
 * per window (when that IP's window rolls over, is swept, or is evicted).
 * Memory is bounded: at most `maxKeys` IPs; past that the oldest is evicted.
 *
 * A GLOBAL ceiling (`globalLimit` rows / `windowMs`, all IPs together) sits on
 * top, so rotating source addresses (e.g. across an IPv6 /64) cannot multiply
 * the per-IP budget. Globally suppressed rows do not consume the IP's own
 * budget; their count is reported once per global window via
 * `onGlobalSuppressed` (on the first call after the window rolls over).
 */
/** Default total guard-rejection audit rows per window across all IPs. */
export const REJECTION_AUDIT_GLOBAL_LIMIT = 600;

export interface RejectionAuditLimiterOptions {
  limit?: number;
  globalLimit?: number;
  windowMs?: number;
  maxKeys?: number;
  now?: () => number;
  onSuppressed?: (ip: string, suppressed: number) => void;
  onGlobalSuppressed?: (suppressed: number) => void;
}

interface Bucket {
  windowStart: number;
  count: number;
  suppressed: number;
}

export class RejectionAuditLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly onSuppressed: (ip: string, suppressed: number) => void;
  private readonly globalLimit: number;
  private readonly onGlobalSuppressed: (suppressed: number) => void;
  private readonly buckets = new Map<string, Bucket>();
  private readonly global: Bucket;
  private lastSweep: number;

  constructor(opts: RejectionAuditLimiterOptions = {}) {
    this.limit = opts.limit ?? 60;
    this.windowMs = opts.windowMs ?? 60_000;
    this.maxKeys = opts.maxKeys ?? 10_000;
    this.now = opts.now ?? Date.now;
    this.onSuppressed = opts.onSuppressed ?? (() => undefined);
    this.globalLimit = opts.globalLimit ?? REJECTION_AUDIT_GLOBAL_LIMIT;
    this.onGlobalSuppressed = opts.onGlobalSuppressed ?? (() => undefined);
    this.lastSweep = this.now();
    this.global = { windowStart: this.lastSweep, count: 0, suppressed: 0 };
  }

  get size(): number {
    return this.buckets.size;
  }

  /** True if a rejection row may be written for this IP now. */
  allow(ip: string): boolean {
    const now = this.now();
    if (now - this.lastSweep >= this.windowMs) this.sweep(now);
    if (now - this.global.windowStart >= this.windowMs) {
      if (this.global.suppressed > 0)
        this.onGlobalSuppressed(this.global.suppressed);
      this.global.windowStart = now;
      this.global.count = 0;
      this.global.suppressed = 0;
    }

    let bucket = this.buckets.get(ip);
    if (bucket && now - bucket.windowStart >= this.windowMs) {
      this.retire(ip, bucket);
      bucket = undefined;
    }
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.evictOldest();
      bucket = { windowStart: now, count: 0, suppressed: 0 };
      this.buckets.set(ip, bucket);
    }
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

  private sweep(now: number): void {
    this.lastSweep = now;
    for (const [ip, bucket] of this.buckets) {
      if (now - bucket.windowStart >= this.windowMs) this.retire(ip, bucket);
    }
  }

  private evictOldest(): void {
    const oldest = this.buckets.entries().next();
    if (!oldest.done) this.retire(oldest.value[0], oldest.value[1]);
  }

  private retire(ip: string, bucket: Bucket): void {
    this.buckets.delete(ip);
    if (bucket.suppressed > 0) this.onSuppressed(ip, bucket.suppressed);
  }
}
