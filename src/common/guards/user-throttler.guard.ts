import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ThrottlerException, ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler';

/**
 * Keys the rate limit by the *verified* authenticated user (so concurrent users
 * behind one shared/NAT IP each get their own budget), falling back to the
 * client IP for anonymous routes (login/refresh). Relies on the global guard
 * order JwtAuthGuard -> UserThrottlerGuard, so `req.user` is set when present.
 *
 * The param is typed (not the base's `Record<string, any>`) — a valid bivariant
 * method override that keeps the body free of unsafe `any` access.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: {
    user?: { id?: string };
    ip?: string;
    body?: { email?: unknown };
  }): Promise<string> {
    const userId = req.user?.id;
    if (userId) return Promise.resolve(`user:${userId}`);
    // Anonymous: a login carries an email — key by it so per-account brute force
    // is bounded regardless of a spoofed X-Forwarded-For. Combining with IP would
    // let a rotating spoofed IP restore a fresh budget, defeating the limit.
    const email =
      typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : null;
    if (email) return Promise.resolve(`login:${email}`);
    return Promise.resolve(`ip:${req.ip ?? 'unknown'}`);
  }

  /**
   * Fail-closed: a real limit hit stays a 429 (ThrottlerException); any other error
   * (the Redis store being unavailable) becomes a 503 so we never silently stop
   * limiting. Paired with the fail-fast ioredis client, this rejects promptly.
   */
  protected async handleRequest(
    requestProps: ThrottlerRequest,
  ): Promise<boolean> {
    try {
      return await super.handleRequest(requestProps);
    } catch (err) {
      if (err instanceof ThrottlerException) throw err;
      throw new ServiceUnavailableException('Rate limiter unavailable');
    }
  }
}
