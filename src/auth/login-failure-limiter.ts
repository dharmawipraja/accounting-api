import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.constants';
import { MetricsService } from '../metrics/metrics.service';
import { LOGIN_FAILURE } from '../config/throttle.config';
import { normalizeEmail } from '../users/normalize-email';

/**
 * Per-account failed-login ceiling that cannot be used to lock the owner out.
 *
 * The per-minute login throttle is keyed by (email, IP), so guessing from many
 * IPs is bounded here instead: once an account collects `LOGIN_FAILURE.limit`
 * failures within the window, further attempts are refused (429) — but ONLY
 * from IPs that have never logged in to that account successfully. The owner's
 * usual IPs keep working while an attacker sprays the account.
 * `LOGIN_FAILURE.hardLimit` is an ABSOLUTE ceiling that ignores the known-IP
 * exemption: past it every IP is refused, so a guesser sharing the owner's IP
 * (one office NAT) is bounded too. The trade-off is that a spray past the hard
 * limit locks the owner out until the window ends.
 *
 * Redis in dev/prod (shared across replicas, fail-closed like the throttler);
 * an in-process Map in tests (no Redis there).
 * ponytail: the Map fallback never evicts — tests only; prod always has Redis.
 */
@Injectable()
export class LoginFailureLimiter {
  private readonly logger = new Logger(LoginFailureLimiter.name);
  private readonly mem = new Map<string, { n: number; exp: number }>();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
    private readonly metrics: MetricsService,
  ) {}

  /** Throws 429 when the account is over its hard failure ceiling, or over its
   *  soft ceiling and `ip` is not one it has logged in from before. Call BEFORE
   *  verifying the password. */
  async assertAllowed(email: string, ip: string | undefined): Promise<void> {
    const key = normalizeEmail(email);
    const failures = await this.get(`lf:${key}`);
    if (failures < LOGIN_FAILURE.hardLimit) {
      if (failures < LOGIN_FAILURE.limit) return;
      if (ip && (await this.get(`lk:${key}:${ip}`)) > 0) return;
    }
    this.metrics.incLoginLockout();
    throw new HttpException(
      'Too many failed logins for this account; try again later',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  async recordFailure(email: string): Promise<void> {
    const key = normalizeEmail(email);
    this.metrics.incLoginFailure();
    const n = await this.incr(`lf:${key}`, LOGIN_FAILURE.windowMs);
    if (n === LOGIN_FAILURE.limit)
      this.logger.warn({ event: 'login_failure_ceiling', email: key });
    if (n === LOGIN_FAILURE.hardLimit)
      this.logger.warn({ event: 'login_failure_hard_ceiling', email: key });
  }

  async recordSuccess(email: string, ip: string | undefined): Promise<void> {
    if (!ip) return;
    await this.set(
      `lk:${normalizeEmail(email)}:${ip}`,
      LOGIN_FAILURE.knownIpTtlMs,
    );
  }

  /** Fail closed like the throttler: a Redis error is a 503, never a silent
   *  skip of the ceiling. */
  private async redisOr503<T>(op: (r: Redis) => Promise<T>): Promise<T> {
    try {
      return await op(this.redis!);
    } catch {
      throw new ServiceUnavailableException('Rate limiter unavailable');
    }
  }

  private async get(k: string): Promise<number> {
    if (this.redis) return Number(await this.redisOr503((r) => r.get(k))) || 0;
    const e = this.mem.get(k);
    return e && e.exp > Date.now() ? e.n : 0;
  }

  private async incr(k: string, ttlMs: number): Promise<number> {
    if (this.redis) {
      // One MULTI: the counter can never exist without a TTL (an INCR whose
      // separate PEXPIRE failed would lock new IPs out forever). NX keeps the
      // window fixed from the first failure (Redis >= 7).
      return this.redisOr503(async (r) => {
        const res = await r.multi().incr(k).pexpire(k, ttlMs, 'NX').exec();
        if (!res || res.some(([err]) => err)) throw new Error('multi failed');
        return Number(res[0][1]);
      });
    }
    const e = this.mem.get(k);
    const live =
      e && e.exp > Date.now() ? e : { n: 0, exp: Date.now() + ttlMs };
    live.n += 1;
    this.mem.set(k, live);
    return live.n;
  }

  private async set(k: string, ttlMs: number): Promise<void> {
    if (this.redis) await this.redisOr503((r) => r.set(k, '1', 'PX', ttlMs));
    else this.mem.set(k, { n: 1, exp: Date.now() + ttlMs });
  }
}
