import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Observable, from, throwError } from 'rxjs';
import { catchError, concatMap } from 'rxjs/operators';
import { AuditService } from './audit.service';
import { statusFromException } from '../common/errors/exception-status';
import {
  auditBaseOf,
  bindsRequestBody,
  isMutating,
  markAudited,
  type AuditableRequest,
} from './audit-request';
import { RejectionAuditLimiter } from './rejection-audit-limiter';
import { READ_ONLY_POST_KEY } from './read-only-post';
import { TOKEN_GRANT_KEY, tokenGrantSubject } from './token-grant';
import { isBodyValidated } from './validated-body';
import {
  isLoginIpThrottled,
  markLoginAttempt,
} from '../common/guards/login-ip-throttle';

function boundedId(id: unknown): string | null {
  return typeof id === 'string' && id.length > 0 && id.length <= 128
    ? id
    : null;
}

/** The created/affected entity's id, when the response body carries one —
 *  either `{ id }` or the `{ user, tempPassword }` shape of user create /
 *  reset-password (the entity is the user). */
export function entityIdOf(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  if ('id' in data) return boundedId(data.id);
  if ('user' in data && data.user && typeof data.user === 'object') {
    return 'id' in data.user ? boundedId(data.user.id) : null;
  }
  return null;
}

/** Whether the routed handler binds the request body (`@Body()`, `@Req()` or
 *  `@RawBody()`), read from Nest's route-argument metadata — the same
 *  `(class, method name)` lookup Nest's router uses to build the arguments.
 *  Unknown handler/class (never for a routed HTTP request) → true, the
 *  conservative answer that keeps the body (still size-capped). */
export function handlerBindsBody(ctx: ExecutionContext): boolean {
  const handler = ctx.getHandler?.();
  const cls = ctx.getClass?.();
  if (typeof handler !== 'function' || !handler.name || !cls) return true;
  return bindsRequestBody(
    Reflect.getMetadata(ROUTE_ARGS_METADATA, cls, handler.name),
  );
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  /** @param limiter the app's shared RejectionAuditLimiter: anonymous rows
   *  count against its anonymous global ceiling — every anonymous 4xx / 5xx
   *  and every anonymous 2xx EXCEPT a successful login (exempt) or refresh
   *  (per-owner budget first, `allowTokenGrant`).
   *  @param reflector reads the `@ReadOnlyPost()` / `@TokenGrant()` handler
   *  markers. */
  constructor(
    private readonly audit: AuditService,
    private readonly limiter: RejectionAuditLimiter,
    private readonly reflector: Reflector,
  ) {}

  /** Whether the routed handler is marked `@ReadOnlyPost()` (8 KiB tier for
   *  every row). No handler (never for a routed request) → false. */
  private isReadOnly(ctx: ExecutionContext): boolean {
    const handler = ctx.getHandler?.();
    return (
      typeof handler === 'function' &&
      this.reflector.get<boolean>(READ_ONLY_POST_KEY, handler) === true
    );
  }

  private isTokenGrant(ctx: ExecutionContext): boolean {
    const handler = ctx.getHandler?.();
    return (
      typeof handler === 'function' &&
      this.reflector.get<boolean>(TOKEN_GRANT_KEY, handler) === true
    );
  }

  /** Whether an ANONYMOUS success row may be written. A successful login
   *  (`@LoginIpThrottle()` handler) proves valid credentials and is bounded
   *  by the per-IP / per-email throttles: always written — cheap anonymous
   *  401s must not be able to hide a (possibly credential-stuffed) successful
   *  login. A successful refresh (`@TokenGrant()`) proves a valid refresh
   *  token: written within a per-owner budget (`allowTokenGrant`, 60/min —
   *  never touching the global ceiling), past it under the global ceiling (a
   *  single chained token across rotating IPs cannot write unbounded rows).
   *  Everything else (e.g. logout) shares the anonymous global ceiling. */
  private allowAnonymousSuccess(
    ctx: ExecutionContext,
    status: number,
    data: unknown,
  ): boolean {
    const success = status >= 200 && status < 300;
    if (success && isLoginIpThrottled(ctx.getHandler?.())) return true;
    if (success && this.isTokenGrant(ctx)) {
      return this.limiter.allowTokenGrant(tokenGrantSubject(data));
    }
    return this.limiter.allowAnonymousGlobal();
  }

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<AuditableRequest>();
    if (!isMutating(req.method)) return next.handle();
    // Claim the request: the exception filter must not write a second row.
    markAudited(req);
    if (isLoginIpThrottled(ctx.getHandler())) markLoginAttempt(req);
    const start = Date.now();
    const res = ctx.switchToHttp().getResponse<{ statusCode: number }>();
    // The stored body depends on the outcome (512 KiB only for an
    // authenticated 2xx — or 408 / 5xx on a body the ValidationPipe accepted
    // — on a body-binding, state-changing handler; 8 KiB otherwise, incl.
    // every row of a @ReadOnlyPost() handler; {} for a bodyless handler) — so
    // the base is built when the status is known. `bodyValidated` is read at
    // outcome time: the pipe runs after this interceptor, inside next.handle().
    const bindsBody = handlerBindsBody(ctx);
    const readOnly = this.isReadOnly(ctx);
    return next.handle().pipe(
      concatMap((data) => {
        // Anonymous successes share the anonymous global ceiling too (e.g.
        // logout, which always answers 200): past it the row is dropped
        // (counted + logged by the limiter), the response still goes out.
        // A successful login is exempt; a refresh has a per-owner budget
        // first (allowAnonymousSuccess).
        if (!req.user && !this.allowAnonymousSuccess(ctx, res.statusCode, data))
          return from([data]);
        return from(
          this.audit.record({
            ...auditBaseOf(req, {
              status: res.statusCode,
              bindsBody,
              readOnly,
              bodyValidated: isBodyValidated(req.body),
            }),
            entityId: entityIdOf(data),
            statusCode: res.statusCode,
            durationMs: Date.now() - start,
          }),
        ).pipe(concatMap(() => from([data])));
      }),
      catchError((err: unknown) => {
        // Record the SAME status AllExceptionsFilter will return — one shared mapping
        // (HttpException, DomainError, and both Prisma families) so the audit row can
        // never disagree with the client response.
        const statusCode = statusFromException(err);
        // Anonymous errors (login / refresh / logout 4xx AND 5xx) share the
        // anonymous global rejection ceiling: past it the row is dropped
        // (counted + logged by the limiter), the error still propagates.
        if (!req.user && !this.limiter.allowAnonymousGlobal()) {
          return throwError(() => err);
        }
        return from(
          this.audit.record({
            // Anonymous client errors store no body (e.g. a 400 on
            // /auth/refresh → {}); a failed LOGIN keeps only `{ email }`.
            ...auditBaseOf(req, {
              status: statusCode,
              bindsBody,
              readOnly,
              bodyValidated: isBodyValidated(req.body),
            }),
            entityId: null,
            statusCode,
            durationMs: Date.now() - start,
          }),
        ).pipe(concatMap(() => throwError(() => err)));
      }),
    );
  }
}
