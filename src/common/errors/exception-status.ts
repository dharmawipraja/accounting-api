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

/** Postgres SQLSTATEs for a transaction aborted by a concurrent one or by a
 *  server-side timeout: deadlock (40P01), serialization failure (40001), a lock
 *  wait that hit `lock_timeout` (55P03 lock_not_available), and a statement
 *  cancelled by `statement_timeout` (57014 query_canceled — the transaction is
 *  rolled back, like P2028). Safe to retry as-is. Prisma 7 surfaces 57014 as
 *  P2010 (raw query) or P2039 (model query), each carrying
 *  `meta.driverAdapterError.cause.originalCode`. */
const TRANSIENT_PG_CODES = new Set(['40P01', '40001', '55P03', '57014']);

/** Envelope for a transient transaction conflict. The tx rolled back, so
 *  nothing committed and the idempotency key was released — a retry (same key)
 *  is safe. */
export const TRANSIENT_CONFLICT = {
  status: 409,
  code: 'CONFLICT',
  message:
    'The request conflicted with a concurrent transaction and was rolled back; retry it',
  details: { retryable: true },
} as const;

/** Prisma codes for a rolled-back transaction: P2034 (write conflict /
 *  serialization failure) and P2028 (transaction-API error — the interactive
 *  tx could not start within `maxWait`, or ran past `timeout` and was closed by
 *  the client). Nothing committed, so both are retryable like a deadlock. */
const TRANSIENT_PRISMA_CODES = new Set(['P2034', 'P2028']);

/** SQLSTATE carried by a Prisma 7 driver-adapter error (`{ name:
 *  'DriverAdapterError', cause: { originalCode, code, … } }`), if any. */
function driverAdapterCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const { name, cause } = e as { name?: unknown; cause?: unknown };
  if (name !== 'DriverAdapterError' || typeof cause !== 'object' || !cause)
    return undefined;
  const c = cause as { originalCode?: unknown; code?: unknown };
  const code = c.originalCode ?? c.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * True for a deadlock / serialization failure / lock timeout / statement
 * timeout / transaction-API timeout, however Prisma 7 + the pg adapter surfaces it: P2034 (a 40001 on a
 * model query), P2028 (interactive-tx maxWait/timeout expired), P2010 with
 * `meta.driverAdapterError` (a raw query), or a bare DriverAdapterError (a
 * 40P01 on a model query — the client rethrows it unwrapped). Pure.
 */
export function isTransientConflict(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (TRANSIENT_PRISMA_CODES.has(err.code)) return true;
    const code = driverAdapterCode(
      (err.meta as { driverAdapterError?: unknown } | undefined)
        ?.driverAdapterError,
    );
    return code !== undefined && TRANSIENT_PG_CODES.has(code);
  }
  const code = driverAdapterCode(err);
  return code !== undefined && TRANSIENT_PG_CODES.has(code);
}

/**
 * The HTTP status an exception maps to — the single source shared by
 * `AllExceptionsFilter` (the client response) and `AuditInterceptor` (the recorded
 * audit-row status), so the two can never disagree. Pure: no logging or Sentry
 * side effects (the filter owns those). Family order mirrors the filter exactly.
 */
export function statusFromException(err: unknown): number {
  if (err instanceof DomainError) return err.status;
  if (err instanceof HttpException) return err.getStatus();
  if (isTransientConflict(err)) return TRANSIENT_CONFLICT.status;
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return PRISMA_STATUS[err.code]?.status ?? 500;
  }
  if (err instanceof Prisma.PrismaClientValidationError) return 400;
  return 500;
}
