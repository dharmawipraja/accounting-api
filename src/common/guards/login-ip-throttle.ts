import { SetMetadata } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerOptions } from '@nestjs/throttler';
import { THROTTLE, THROTTLE_TTL_MS } from '../../config/throttle.config';

const LOGIN_IP_THROTTLE_KEY = 'throttle:login-ip';

/** Name of the per-client-IP login throttler (registered in AppModule). */
export const LOGIN_IP_THROTTLER = 'loginIp';

/**
 * Opts a route into the per-client-IP login ceiling. The per-email bucket
 * (UserThrottlerGuard.getTracker) bounds guessing against ONE account; this
 * bounds a single client spraying MANY emails — each attempt costs an argon2id
 * verify (real or decoy), so without it rotating emails is a CPU/memory DoS.
 * Relies on `trust proxy` (main.ts, TRUST_PROXY_HOPS) so `req.ip` is the
 * Caddy-forwarded client address, not a client-forged X-Forwarded-For.
 */
export const LoginIpThrottle = (): MethodDecorator & ClassDecorator =>
  SetMetadata(LOGIN_IP_THROTTLE_KEY, true);

/** The named throttler: inert (skipped) on every route not marked above. */
export function loginIpThrottler(): ThrottlerOptions {
  return {
    name: LOGIN_IP_THROTTLER,
    ttl: THROTTLE_TTL_MS,
    limit: THROTTLE.loginIp,
    skipIf: (ctx: ExecutionContext) =>
      Reflect.getMetadata(LOGIN_IP_THROTTLE_KEY, ctx.getHandler()) !== true,
    getTracker: (req: Record<string, unknown>) =>
      `loginip:${typeof req.ip === 'string' ? req.ip : 'unknown'}`,
  };
}
