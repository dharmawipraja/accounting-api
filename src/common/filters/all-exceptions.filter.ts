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
  isPayloadTooLarge,
  isTransientConflict,
  PAYLOAD_TOO_LARGE,
  PRISMA_STATUS,
  statusFromException,
  TRANSIENT_CONFLICT,
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
    } else if (isPayloadTooLarge(exception)) {
      // body-parser rejected an over-limit body before routing: a client
      // error, not an incident (no Sentry, no audit row — no guard ran).
      envelope = {
        code: PAYLOAD_TOO_LARGE.code,
        message: PAYLOAD_TOO_LARGE.message,
      };
      this.logger.log(`Request body over the parser limit -> 413 on ${url}`);
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
    this.auditRejection(req as AuditableRequest, status);
  }

  /** Guard rejection → one audit row, fire-and-forget after the response:
   *  a slow or failing audit INSERT never delays or breaks the 401/403/429. */
  private auditRejection(req: AuditableRequest, status: number): void {
    if (!this.audit || !shouldAuditRejection(req, status)) return;
    markAudited(req);
    if (!this.rejectionLimiter.allow(req.ip ?? 'unknown', req.user?.id)) return;
    let pending: Promise<void>;
    try {
      pending = this.audit.record({
        // No handler here: guard rejections are >= 400, so an authenticated
        // row takes the 8 KiB cap and an anonymous one stores {}.
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
