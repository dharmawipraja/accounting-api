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
import { PRISMA_STATUS, statusFromException } from '../errors/exception-status';

interface ErrorEnvelope {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  traceId?: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const req = ctx.getRequest<{ url?: string; id?: string }>();
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
    response.status(status).json(envelope);
  }
}
