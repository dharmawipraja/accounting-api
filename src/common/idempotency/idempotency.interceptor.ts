import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Observable, from, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { createHash } from 'crypto';
import { IDEMPOTENT_KEY } from './idempotent.decorator';

// Bounds the stored PK (`IdempotencyKey.key String @id`) and rejects garbage.
// UUIDs (the frontend default) and other compact tokens pass.
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
import { IdempotencyService } from './idempotency.service';
import { idempotencyContext } from './idempotency-context';
import { ValidationFailedError } from '../errors/domain-errors';

interface IdempotentRequest {
  method: string;
  originalUrl?: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  /** Set by JwtAuthGuard, which runs before interceptors on every @Idempotent route. */
  user?: { id: string };
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idempotency: IdempotencyService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const enabled = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!enabled) return next.handle();

    const req = ctx.switchToHttp().getRequest<IdempotentRequest>();
    const res = ctx.switchToHttp().getResponse<{ statusCode: number }>();
    const header = req.headers['idempotency-key'];
    const key = Array.isArray(header) ? header[0] : header;
    if (!key) {
      throw new ValidationFailedError('Idempotency-Key header is required');
    }
    if (!IDEMPOTENCY_KEY_RE.test(key)) {
      throw new ValidationFailedError(
        'Idempotency-Key must be 1–128 characters of [A-Za-z0-9._:-]',
      );
    }
    // Keys are namespaced per user so one caller can never replay another's.
    const userId = req.user?.id;
    if (!userId) {
      throw new ValidationFailedError(
        'Idempotent requests require an authenticated user',
      );
    }
    const method = req.method;
    // Includes the query string intentionally: it scopes the key to the exact
    // request target, so e.g. a draft create and `?post=true` create-and-post
    // are treated as different endpoints (cross-endpoint 422) rather than one
    // silently replaying the other's response. Don't "normalize" this away.
    const path = req.originalUrl ?? req.url;
    const requestHash = createHash('sha256')
      .update(JSON.stringify(req.body ?? null))
      .digest('hex');
    // Resolve the status the handler would emit so a replay reproduces it.
    const declared = this.reflector.get<number | undefined>(
      HTTP_CODE_METADATA,
      ctx.getHandler(),
    );
    const httpStatus = declared ?? (method === 'POST' ? 201 : 200);

    return from(
      this.idempotency.reserve(userId, key, method, path, requestHash),
    ).pipe(
      switchMap((reserved) => {
        if (reserved.replay) {
          res.statusCode = reserved.httpStatus;
          return of(reserved.response);
        }
        // Run the handler inside the idempotency ALS context so every
        // PrismaService.transaction it opens marks this key committed as its
        // last statement. Nest's handle() binds the downstream chain (via
        // AsyncResource.bind) to the async context current when handle() is
        // CALLED, so calling it inside run() carries the context into the
        // controller and service layer.
        const { token } = reserved;
        const handled = idempotencyContext.run({ userId, key, token }, () =>
          next.handle(),
        );
        return handled.pipe(
          // Handler failed: release the key so a retry can re-attempt — release()
          // keeps it if the write had already committed (retry then gets 409).
          catchError((err: unknown) =>
            from(this.idempotency.release(userId, key, token)).pipe(
              switchMap(() => {
                throw err;
              }),
            ),
          ),
          // Handler succeeded, so its write committed. If recording the
          // response fails, NEVER release (a retry would re-execute the write):
          // leave the committed reservation so the retry gets 409.
          switchMap((data: unknown) =>
            from(
              this.idempotency.complete(userId, key, token, data, httpStatus),
            ).pipe(
              catchError((err: unknown) =>
                from(this.idempotency.markCommitted(userId, key, token)).pipe(
                  switchMap(() => {
                    throw err;
                  }),
                ),
              ),
              map((): unknown => data),
            ),
          ),
        );
      }),
    );
  }
}
