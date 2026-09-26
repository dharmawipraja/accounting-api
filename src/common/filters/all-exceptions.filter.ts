import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import * as Sentry from '@sentry/node';
import { DomainError } from '../errors/domain-errors';
import {
  CONSTRAINT_VIOLATION,
  constraintNameOf,
  isConstraintViolation,
  isBodyParserClientError,
  isTransientConflict,
  isUnstorableCharacters,
  isValueOutOfRange,
  PAYLOAD_TOO_LARGE,
  PRISMA_STATUS,
  statusFromException,
  TRANSIENT_CONFLICT,
  UNSTORABLE_CHARACTERS,
  VALUE_OUT_OF_RANGE,
} from '../errors/exception-status';
import type { AuditService } from '../../audit/audit.service';
import {
  auditBaseOf,
  markAudited,
  shouldAuditRejection,
  type AuditableRequest,
} from '../../audit/audit-request';
import {
  loggingRejectionAuditLimiter,
  RejectionAuditLimiter,
} from '../../audit/rejection-audit-limiter';

interface ErrorEnvelope {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  traceId?: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  private readonly rejectionLimiter: RejectionAuditLimiter;

  /** @param audit when given, mutating requests rejected by a GUARD (401/403/
   *  429 — guards run before AuditInterceptor) are audited here: one row, no
   *  body when anonymous (unauthenticated input is not trusted into the log).
   *  The row is written fire-and-forget AFTER the response, and capped per
   *  caller: anonymous per client IP + a global ceiling (anonymous 401s are not
   *  throttled — JwtAuthGuard runs first); authenticated per user. Pass the
   *  app's shared `RejectionAuditLimiter` (AuditModule) so AuditInterceptor's
   *  anonymous rows count against the same global ceiling. */
  constructor(
    private readonly audit?: Pick<AuditService, 'record'>,
    limiter?: RejectionAuditLimiter,
  ) {
    this.rejectionLimiter =
      limiter ?? loggingRejectionAuditLimiter(this.logger);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const req = ctx.getRequest<
      { url?: string; id?: string } & Partial<AuditableRequest>
    >();
    const url = req.url ?? 'unknown';

    const status = statusFromException(exception);
    let envelope: ErrorEnvelope = {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    };

    if (exception instanceof DomainError) {
      envelope = {
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    } else if (exception instanceof HttpException) {
      const res = exception.getResponse();
      if (typeof res === 'string') {
        envelope = { code: `HTTP_${status}`, message: res };
      } else {
        const rawMessage = (res as { message?: string | string[] }).message;
        if (Array.isArray(rawMessage)) {
          // class-validator (ValidationPipe) yields an array of per-field
          // messages — preserve them so the frontend can show field errors.
          envelope = {
            code: `HTTP_${status}`,
            message: 'Validation failed',
            details: { errors: rawMessage },
          };
        } else {
          envelope = {
            code: `HTTP_${status}`,
            message: rawMessage ?? exception.message,
          };
        }
      }
    } else if (isTransientConflict(exception)) {
      // Deadlock / serialization failure: the tx rolled back — a client retry
      // is safe. Expected under contention, so warn (no Sentry).
      envelope = {
        code: TRANSIENT_CONFLICT.code,
        message: TRANSIENT_CONFLICT.message,
        details: { ...TRANSIENT_CONFLICT.details },
      };
      this.logger.warn(
        `Transient transaction conflict -> ${status} on ${url}: ${
          exception instanceof Error ? exception.message : String(exception)
        }`,
      );
    } else if (isConstraintViolation(exception)) {
      // CHECK / NOT NULL violation that escaped service validation: a generic
      // 422 backstop (no SQL / constraint names in the response). It only
      // fires on a validation gap (a code defect — e.g. the deferred
      // journal_entry_balanced trigger), so it is logged at ERROR with the
      // constraint name and reported to Sentry at warning level.
      envelope = {
        code: CONSTRAINT_VIOLATION.code,
        message: CONSTRAINT_VIOLATION.message,
      };
      const constraint = constraintNameOf(exception) ?? 'unknown';
      this.logger.error(
        `Constraint violation (${constraint}) -> ${status} on ${url}: ${
          exception instanceof Error ? exception.message : String(exception)
        }`,
      );
      Sentry.captureException(exception, {
        level: 'warning',
        tags: {
          kind: 'constraint-backstop',
          constraint,
          traceId: req.id,
        },
        extra: { path: url },
      });
    } else if (isUnstorableCharacters(exception)) {
      // A U+0000 / untranslatable character reached Postgres (22021/22P05):
      // client input, not an incident — 400 INVALID_CHARACTERS, warn only.
      envelope = {
        code: UNSTORABLE_CHARACTERS.code,
        message: UNSTORABLE_CHARACTERS.message,
      };
      this.logger.warn(
        `Unstorable character -> ${status} on ${url}: ${
          exception instanceof Error ? exception.message : String(exception)
        }`,
      );
    } else if (isValueOutOfRange(exception)) {
      // A date/time outside the column's range reached Postgres (22008):
      // client input, not an incident — 400 INVALID_INPUT, warn only.
      envelope = {
        code: VALUE_OUT_OF_RANGE.code,
        message: VALUE_OUT_OF_RANGE.message,
      };
      this.logger.warn(
        `Value out of range -> ${status} on ${url}: ${
          exception instanceof Error ? exception.message : String(exception)
        }`,
      );
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = PRISMA_STATUS[exception.code];
      if (mapped) {
        envelope = { code: mapped.code, message: mapped.message };
        this.logger.warn(
          `Prisma ${exception.code} -> ${status} on ${url}: ${exception.message}`,
        );
      } else {
        // Unknown Prisma code: stay 500 + INTERNAL_ERROR, but log loudly.
        this.logger.error(
          `Unmapped Prisma ${exception.code} on ${url}`,
          exception.stack,
        );
        Sentry.captureException(exception, {
          tags: { traceId: req.id },
          extra: { path: url },
        });
      }
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      envelope = { code: 'INVALID_INPUT', message: 'Invalid input' };
      this.logger.warn(`Prisma validation error -> 400 on ${url}`);
    } else if (isBodyParserClientError(exception)) {
      // body-parser rejected the body before routing (over the size cap,
      // unsupported charset / encoding, aborted upload, corrupt gzip/deflate
      // stream): a client error, not an incident (info log, no Sentry, no
      // audit row — no guard ran).
      if (status === PAYLOAD_TOO_LARGE.status) {
        envelope = {
          code: PAYLOAD_TOO_LARGE.code,
          message: PAYLOAD_TOO_LARGE.message,
        };
      } else {
        const { message, expose } = exception as {
          message?: unknown;
          expose?: unknown;
        };
        envelope = {
          code: `HTTP_${status}`,
          // http-errors marks client-safe messages `expose: true`.
          message:
            expose === true && typeof message === 'string'
              ? message
              : 'Bad request',
        };
      }
      const { type, code } = exception as { type?: unknown; code?: unknown };
      const kind =
        typeof type === 'string'
          ? type
          : typeof code === 'string'
            ? code
            : 'untyped';
      this.logger.log(
        `Request body rejected by the parser (${kind}) -> ${status} on ${url}`,
      );
    } else {
      this.logger.error(
        `Unhandled exception on ${url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
      Sentry.captureException(exception, {
        tags: { traceId: req.id },
        extra: { path: url },
      });
    }

    if (req.id) envelope.traceId = req.id;
    response.status(status).json(envelope);
    this.auditRejection(req as AuditableRequest, status, exception);
  }

  /** Guard (or input-hygiene) rejection → one audit row, fire-and-forget
   *  after the response: a slow or failing audit INSERT never delays or
   *  breaks the 401/403/429/400. */
  private auditRejection(
    req: AuditableRequest,
    status: number,
    exception: unknown,
  ): void {
    if (!this.audit || !shouldAuditRejection(req, status, exception)) return;
    markAudited(req);
    if (!this.rejectionLimiter.allow(req.ip ?? 'unknown', req.user?.id)) return;
    let pending: Promise<void>;
    try {
      pending = this.audit.record({
        // No handler here: these rejections are >= 400, so an authenticated
        // row takes the 8 KiB cap and an anonymous one stores {} (a login
        // attempt keeps its normalized email).
        ...auditBaseOf(req, { status }),
        entityId: null,
        statusCode: status,
        durationMs: 0, // rejected before any handler work
      });
    } catch (err) {
      pending = Promise.reject(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
    pending.catch((err: unknown) =>
      this.logger.warn(`Guard-rejection audit write failed: ${String(err)}`),
    );
  }
}
