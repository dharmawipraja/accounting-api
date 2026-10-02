import {
  ArgumentMetadata,
  BadRequestException,
  HttpException,
  Logger,
  ValidationPipe,
  type ValidationPipeOptions,
} from '@nestjs/common';
import * as Sentry from '@sentry/node';

/** The global ValidationPipe, with a backstop for validators that throw. */
export class BackstopValidationPipe extends ValidationPipe {
  private readonly backstopLogger = new Logger('BackstopValidationPipe');

  /** A validator that THROWS instead of failing is a 400, not a 500; a
   *  normal validation failure keeps its own HttpException. A URIError
   *  (validator.js' `isEmail` on a lone surrogate — client input) is a warn
   *  log only; any OTHER throw is a validator defect worth seeing, so it is
   *  also reported to Sentry at warning level (tag `kind: validator-backstop`)
   *  — still a 400 for the caller. */
  override async transform(
    value: unknown,
    metadata: ArgumentMetadata,
  ): Promise<unknown> {
    try {
      return (await super.transform(value, metadata)) as unknown;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.backstopLogger.warn(
        `A validator threw while validating the ${metadata.type} -> 400: ${String(err)}`,
      );
      if (!(err instanceof URIError)) {
        Sentry.captureException(err, {
          level: 'warning',
          tags: { kind: 'validator-backstop', paramType: metadata.type },
        });
      }
      throw new BadRequestException('Request validation failed');
    }
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

export function globalValidationPipe(): BackstopValidationPipe {
  // A fresh copy per pipe: ValidationPipe's constructor takes a mutable type.
  return new BackstopValidationPipe({ ...GLOBAL_VALIDATION_OPTIONS });
}
