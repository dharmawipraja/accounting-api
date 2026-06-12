import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

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
  }): Promise<string> {
    const userId = req.user?.id;
    return Promise.resolve(
      userId ? `user:${userId}` : `ip:${req.ip ?? 'unknown'}`,
    );
  }
}
