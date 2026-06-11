import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, from, throwError } from 'rxjs';
import { catchError, concatMap } from 'rxjs/operators';
import { AuditService } from './audit.service';
import { sanitize } from './audit-sanitize';

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

interface AuditableRequest {
  method: string;
  originalUrl?: string;
  url: string;
  params: Record<string, unknown>;
  body: unknown;
  ip?: string;
  user?: { id: string; role: string };
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
    };
    return next.handle().pipe(
      concatMap((data) =>
        from(
          this.audit.record({
            ...base,
            statusCode: res.statusCode,
            durationMs: Date.now() - start,
          }),
        ).pipe(concatMap(() => from([data]))),
      ),
      catchError((err: unknown) => {
        const statusCode = err instanceof HttpException ? err.getStatus() : 500;
        return from(
          this.audit.record({
            ...base,
            statusCode,
            durationMs: Date.now() - start,
          }),
        ).pipe(concatMap(() => throwError(() => err)));
      }),
    );
  }
}
