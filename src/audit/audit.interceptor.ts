import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, from, throwError } from 'rxjs';
import { catchError, concatMap } from 'rxjs/operators';
import { AuditService } from './audit.service';
import { statusFromException } from '../common/errors/exception-status';
import {
  auditBaseOf,
  auditBodyAllowed,
  isMutating,
  markAudited,
  type AuditableRequest,
} from './audit-request';

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

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<AuditableRequest>();
    if (!isMutating(req.method)) return next.handle();
    // Claim the request: the exception filter must not write a second row.
    markAudited(req);
    const start = Date.now();
    const res = ctx.switchToHttp().getResponse<{ statusCode: number }>();
    const base = auditBaseOf(req, { withBody: true });
    return next.handle().pipe(
      concatMap((data) =>
        from(
          this.audit.record({
            ...base,
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
        return from(
          this.audit.record({
            ...base,
            // Anonymous client errors (e.g. a 400 on /auth/refresh) store no body.
            ...(auditBodyAllowed(req, statusCode) ? {} : { body: {} }),
            entityId: null,
            statusCode,
            durationMs: Date.now() - start,
          }),
        ).pipe(concatMap(() => throwError(() => err)));
      }),
    );
  }
}
