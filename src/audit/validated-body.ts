import {
  ArgumentMetadata,
  BadRequestException,
  HttpException,
  Logger,
  ValidationPipe,
  type ValidationPipeOptions,
} from '@nestjs/common';

/**
 * Request bodies the global ValidationPipe ACCEPTED against a body DTO. Keyed
 * by the raw `req.body` object itself (weakly — nothing is retained past the
 * request): for a whole-body `@Body() dto: SomeDto` Nest hands the pipe
 * `req.body` by reference, so `validatedBodies.has(req.body)` is true exactly
 * when that body passed class-validator (whitelist + forbidNonWhitelisted —
 * every field is bounded by the DTO).
 *
 * Why a pipe and not an interceptor: interceptors run BEFORE pipes, and a
 * pipe's 400 and a handler's throw both surface as an error from
 * `next.handle()` — so only the pipe itself knows validation passed. The mark
 * is set only AFTER `super.transform` resolves, so a rejected body (400) is
 * never marked; a guard rejection never reaches the pipe; `@Body('field')`
 * (value is not `req.body`), `@Req()`, and untyped / primitive `@Body()`
 * params (the pipe skips validation for them) are never marked.
 */
const validatedBodies = new WeakSet<object>();

/** True when `body` (a request's `req.body`) was accepted by the global
 *  ValidationPipe against a body DTO (see `validatedBodies`). Pure lookup. */
export function isBodyValidated(body: unknown): boolean {
  return typeof body === 'object' && body !== null && validatedBodies.has(body);
}

/** The global ValidationPipe, plus the validated-body mark (see
 *  `validatedBodies`) that lets AuditInterceptor keep the large body tier for
 *  an authenticated 408 / 5xx on a body the DTO accepted. */
export class AuditingValidationPipe extends ValidationPipe {
  private readonly backstopLogger = new Logger('AuditingValidationPipe');

  /** Also a backstop: a validator that THROWS instead of failing (e.g.
   *  validator.js' `isEmail` raising URIError on a lone surrogate) is a 400
   *  client error, not a 500 + Sentry; a normal validation failure keeps its
   *  own HttpException. */
  override async transform(
    value: unknown,
    metadata: ArgumentMetadata,
  ): Promise<unknown> {
    let out: unknown;
    try {
      out = await super.transform(value, metadata);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.backstopLogger.warn(
        `A validator threw while validating the ${metadata.type} -> 400: ${String(err)}`,
      );
      throw new BadRequestException('Request validation failed');
    }
    if (
      metadata.type === 'body' &&
      metadata.data === undefined &&
      this.toValidate(metadata) &&
      typeof value === 'object' &&
      value !== null
    ) {
      validatedBodies.add(value);
    }
    return out;
  }
}

/** The app's strict global validation options (main.ts and every e2e
 *  bootstrap share them). Frozen: a shared module-level object must not be
 *  loosened at runtime by one consumer for all the others. */
export const GLOBAL_VALIDATION_OPTIONS: Readonly<ValidationPipeOptions> =
  Object.freeze({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

export function globalValidationPipe(): AuditingValidationPipe {
  // A fresh copy per pipe: ValidationPipe's constructor takes a mutable type.
  return new AuditingValidationPipe({ ...GLOBAL_VALIDATION_OPTIONS });
}
