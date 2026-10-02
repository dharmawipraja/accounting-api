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
import { isIdempotentReplay } from '../common/idempotency/idempotency-replay';
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

/** The owner (`sub`) of the access token in a successful login / refresh
 *  response (`{ accessToken }`, a JWT the server has just signed — so its
 *  payload is trusted without re-verifying), else null. Keys that anonymous
 *  row to its user's audit budget, so a flood of cheap anonymous 401s can
 *  never starve a credential-proving success out of the audit trail. Pure. */
export function accessTokenSubject(data: unknown): string | null {
  if (!data || typeof data !== 'object' || !('accessToken' in data)) {
    return null;
  }
  const token = data.accessToken;
  if (typeof token !== 'string') return null;
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    const sub =
      parsed && typeof parsed === 'object' && 'sub' in parsed
        ? parsed.sub
        : undefined;
    return boundedId(sub);
  } catch {
    return null;
  }
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
  /** @param limiter the app's shared RejectionAuditLimiter: every ANONYMOUS
   *  row goes through it (per-IP + global ceiling; a successful login /
   *  refresh is keyed to its token owner instead). Authenticated rows are
   *  bounded by the per-user throttler and always written.
   *  @param reflector reads the `@ReadOnlyPost()` handler marker. */
  constructor(
    private readonly audit: AuditService,
    private readonly limiter: RejectionAuditLimiter,
    private readonly reflector: Reflector,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<AuditableRequest>();
    if (!isMutating(req.method)) return next.handle();
    // Claim the request: the exception filter must not write a second row.
    markAudited(req);
    const handler = ctx.getHandler();
    if (isLoginIpThrottled(handler)) markLoginAttempt(req);
    const start = Date.now();
    const res = ctx.switchToHttp().getResponse<{ statusCode: number }>();
    const bindsBody = handlerBindsBody(ctx);
    const readOnly =
      typeof handler === 'function' &&
      this.reflector.get<boolean>(READ_ONLY_POST_KEY, handler) === true;
    const ip = req.ip ?? 'unknown';
    // The stored body depends on the outcome (see auditBodyOf), so the row is
    // built once the status is known. Past the limiter an anonymous row is
    // dropped (counted + logged by it); the response still goes out.
    const record = (status: number, entityId: string | null, ok: boolean) =>
      this.audit.record({
        ...auditBaseOf(req, { status, bindsBody, readOnly }),
        entityId,
        // An idempotent replay returned the stored response: flag it so it
        // can't be read as a second creation of the same entity.
        ...(ok && isIdempotentReplay(req) ? { replayed: true } : {}),
        statusCode: status,
        durationMs: Date.now() - start,
      });
    return next.handle().pipe(
      concatMap((data) => {
        if (!req.user && !this.limiter.allow(ip, accessTokenSubject(data)))
          return from([data]);
        return from(record(res.statusCode, entityIdOf(data), true)).pipe(
          concatMap(() => from([data])),
        );
      }),
      catchError((err: unknown) => {
        // Record the SAME status AllExceptionsFilter will return — one shared mapping
        // (HttpException, DomainError, and both Prisma families) so the audit row can
        // never disagree with the client response.
        const statusCode = statusFromException(err);
        if (!req.user && !this.limiter.allow(ip)) {
          return throwError(() => err);
        }
        return from(record(statusCode, null, false)).pipe(
          concatMap(() => throwError(() => err)),
        );
      }),
    );
  }
}
