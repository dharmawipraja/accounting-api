import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Observable, from, of } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { createHash } from 'crypto';
import { IDEMPOTENT_KEY } from './idempotent.decorator';
import { IdempotencyService } from './idempotency.service';
import { ValidationFailedError } from '../errors/domain-errors';

interface IdempotentRequest {
  method: string;
  originalUrl?: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
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
    const method = req.method;
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

    return from(this.idempotency.reserve(key, method, path, requestHash)).pipe(
      switchMap((reserved) => {
        if (reserved.replay) {
          res.statusCode = reserved.httpStatus;
          return of(reserved.response);
        }
        return next.handle().pipe(
          switchMap((data) =>
            from(this.idempotency.complete(key, data, httpStatus)).pipe(
              switchMap(() => of(data)),
            ),
          ),
          catchError((err: unknown) =>
            from(this.idempotency.release(key)).pipe(
              switchMap(() => {
                throw err;
              }),
            ),
          ),
        );
      }),
    );
  }
}
