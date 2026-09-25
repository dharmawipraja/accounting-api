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

/** The created/affected entity's id, when the response body carries one. */
export function entityIdOf(data: unknown): string | null {
  if (data && typeof data === 'object' && 'id' in data) {
    const id = data.id;
    if (typeof id === 'string' && id.length > 0 && id.length <= 128) return id;
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
