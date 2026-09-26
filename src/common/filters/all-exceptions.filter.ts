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
  isTransientConflict,
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

interface ErrorEnvelope {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  traceId?: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  /** @param audit when given, mutating requests rejected by a GUARD (401/403/
   *  429 — guards run before AuditInterceptor) are audited here: one row, no
   *  body for 401 (unauthenticated input is not trusted into the log). */
  constructor(private readonly audit?: Pick<AuditService, 'record'>) {}

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
    const send = () => {
      response.status(status).json(envelope);
    };
    const auditable = req as AuditableRequest;
    if (this.audit && shouldAuditRejection(auditable, status)) {
      markAudited(auditable);
      // record() never throws; respond once the row is written.
      void this.audit
        .record({
          ...auditBaseOf(auditable, { withBody: status !== 401 }),
          entityId: null,
          statusCode: status,
          durationMs: 0, // rejected before any handler work
        })
        .finally(send);
      return;
    }
    send();
  }
}
