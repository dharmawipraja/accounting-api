import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, from, throwError } from 'rxjs';
import { catchError, concatMap } from 'rxjs/operators';
import { AuditService } from './audit.service';
import { sanitize } from './audit-sanitize';
import { statusFromException } from '../common/errors/exception-status';
import { MUTATING_METHODS } from './mutating-methods';

const MUTATING: Set<string> = new Set(MUTATING_METHODS);

interface AuditableRequest {
  method: string;
  originalUrl?: string;
  url: string;
  params: Record<string, unknown>;
  body: unknown;
  ip?: string;
  /** pino-http request id — the same value as X-Request-Id / error traceId. */
  id?: unknown;
  user?: { id: string; role: string };
}

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
    if (!MUTATING.has(req.method)) return next.handle();
    const start = Date.now();
    const res = ctx.switchToHttp().getResponse<{ statusCode: number }>();
    const base = {
      userId: req.user?.id ?? null,
      userRole: req.user?.role ?? null,
      method: req.method,
      path: req.originalUrl ?? req.url,
      params: req.params ?? {},
      body: sanitize(req.body),
      ip: req.ip ?? null,
      requestId:
        typeof req.id === 'string' || typeof req.id === 'number'
          ? String(req.id)
          : null,
    };
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
            entityId: null,
            statusCode,
            durationMs: Date.now() - start,
          }),
        ).pipe(concatMap(() => throwError(() => err)));
      }),
    );
  }
}
