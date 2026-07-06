import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainError } from './domain-errors';

/**
 * Prisma known-request error code → HTTP envelope. The single source for how a
 * Prisma error becomes an HTTP status/code/message, shared by `AllExceptionsFilter`
 * (which builds the response from `code`/`message`) and `statusFromException`
 * (which reads `status`).
 */
export const PRISMA_STATUS: Record<
  string,
  { status: number; code: string; message: string }
> = {
  P2025: { status: 404, code: 'NOT_FOUND', message: 'Resource not found' },
  P2002: { status: 409, code: 'CONFLICT', message: 'Resource already exists' },
  P2003: {
    status: 409,
    code: 'CONFLICT',
    message: 'Operation violates a reference constraint',
  },
  P2023: { status: 400, code: 'INVALID_INPUT', message: 'Invalid input' },
  P2000: { status: 400, code: 'INVALID_INPUT', message: 'Invalid input' },
  P2006: { status: 400, code: 'INVALID_INPUT', message: 'Invalid input' },
  // Numeric overflow (e.g. a computed line amount exceeding Decimal(20,4)) is a
  // client-input problem, not a system incident.
  P2020: { status: 400, code: 'INVALID_INPUT', message: 'Value out of range' },
};

/**
 * The HTTP status an exception maps to — the single source shared by
 * `AllExceptionsFilter` (the client response) and `AuditInterceptor` (the recorded
 * audit-row status), so the two can never disagree. Pure: no logging or Sentry
 * side effects (the filter owns those). Family order mirrors the filter exactly.
 */
export function statusFromException(err: unknown): number {
  if (err instanceof DomainError) return err.status;
  if (err instanceof HttpException) return err.getStatus();
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return PRISMA_STATUS[err.code]?.status ?? 500;
  }
  if (err instanceof Prisma.PrismaClientValidationError) return 400;
  return 500;
}
