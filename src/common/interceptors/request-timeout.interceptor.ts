import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  RequestTimeoutException,
} from '@nestjs/common';
import {
  Observable,
  TimeoutError,
  catchError,
  throwError,
  timeout,
} from 'rxjs';

/** Operational probes must never be capped (liveness/readiness/scrape). */
const PROBE_PATHS = ['/health', '/ready', '/metrics'];

/** Caps each request's handler duration independently of the HTTP server's
 *  `requestTimeout` and the DB `statement_timeout`, returning a clean 408
 *  envelope (via AllExceptionsFilter) instead of a dropped socket. */
@Injectable()
export class RequestTimeoutInterceptor implements NestInterceptor {
  constructor(private readonly timeoutMs: number) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<{ url?: string }>();
    const path = (req?.url ?? '').split('?')[0];
    if (PROBE_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) {
      return next.handle();
    }
    return next.handle().pipe(
      timeout({ each: this.timeoutMs }),
      catchError((err: unknown) =>
        err instanceof TimeoutError
          ? throwError(() => new RequestTimeoutException('Request timed out'))
          : throwError(() => err),
      ),
    );
  }
}
