import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
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
  /** @param limiter the app's shared RejectionAuditLimiter: anonymous 4xx rows
   *  (login / refresh / logout) count against its anonymous global ceiling. */
  constructor(
    private readonly audit: AuditService,
    @Optional() private readonly limiter?: RejectionAuditLimiter,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<AuditableRequest>();
    if (!isMutating(req.method)) return next.handle();
    // Claim the request: the exception filter must not write a second row.
    markAudited(req);
    if (isLoginIpThrottled(ctx.getHandler())) markLoginAttempt(req);
    const start = Date.now();
    const res = ctx.switchToHttp().getResponse<{ statusCode: number }>();
    // The stored body depends on the outcome (512 KiB only for an
    // authenticated 2xx on a body-binding handler; 8 KiB otherwise; {} for a
    // bodyless handler) — so the base is built when the status is known.
    const bindsBody = handlerBindsBody(ctx);
    return next.handle().pipe(
      concatMap((data) =>
        from(
          this.audit.record({
            ...auditBaseOf(req, { status: res.statusCode, bindsBody }),
            entityId: entityIdOf(data),
            statusCode: res.statusCode,
            durationMs: Date.now() - start,
          }),
        ).pipe(concatMap(() => from([data]))),
      ),
      catchError((err: unknown) => {
        // Record the SAME status AllExceptionsFilter will return — one shared mapping
        // (HttpException, DomainError, and both Prisma families) so the audit row can
        // never disagree with the client response.
        const statusCode = statusFromException(err);
        // Anonymous client errors (login / refresh / logout 4xx) share the
        // anonymous global rejection ceiling: past it the row is dropped
        // (counted + logged by the limiter), the error still propagates.
        if (
          !req.user &&
          statusCode >= 400 &&
          statusCode < 500 &&
          this.limiter &&
          !this.limiter.allowAnonymousGlobal()
        ) {
          return throwError(() => err);
        }
        return from(
          this.audit.record({
            // Anonymous client errors store no body (e.g. a 400 on
            // /auth/refresh → {}); a failed LOGIN keeps only `{ email }`.
            ...auditBaseOf(req, { status: statusCode, bindsBody }),
            entityId: null,
            statusCode,
            durationMs: Date.now() - start,
          }),
        ).pipe(concatMap(() => throwError(() => err)));
      }),
    );
  }
}
