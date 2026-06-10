import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { DomainError } from '../errors/domain-errors';

interface ErrorEnvelope {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = 500;
    let envelope: ErrorEnvelope = {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    };

    if (exception instanceof DomainError) {
      status = exception.status;
      envelope = {
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
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
    } else {
      const req = ctx.getRequest<{ url?: string }>();
      this.logger.error(
        `Unhandled exception on ${req.url ?? 'unknown'}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json(envelope);
  }
}
