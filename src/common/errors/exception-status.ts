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
 *  rolled back, like an expired-timeout P2028). Safe to retry as-is. Prisma 7 surfaces 57014 as
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

/** Prisma code for a write conflict / serialization failure: the tx rolled
 *  back, nothing committed, retryable like a deadlock. */
const TRANSIENT_PRISMA_CODES = new Set(['P2034']);

/**
 * P2028 is the catch-all "Transaction API error". Only two of its subtypes
 * mean "rolled back, nothing committed":
 *  - the tx could not start within `maxWait` ("Unable to start a transaction
 *    in the given time.", empty meta) — it never began;
 *  - the tx ran past `timeout` and Prisma closed + rolled it back — any later
 *    query or the COMMIT itself fails with "… cannot be executed on an expired
 *    transaction" and `meta: { operation, timeout, timeTaken }`.
 * The others (use of an already-closed/committed/rolled-back tx, tx not
 * found, internal consistency, bad isolation level) are programming errors or
 * ambiguous about whether work committed, so they stay a 500. Shapes verified
 * against Prisma 7.8 + @prisma/adapter-pg on real Postgres.
 */
function isRetryableP2028(err: Prisma.PrismaClientKnownRequestError): boolean {
  const meta = err.meta as
    | { timeout?: unknown; timeTaken?: unknown }
    | undefined;
  if (typeof meta?.timeout === 'number' && typeof meta.timeTaken === 'number')
    return true;
  return (
    err.message.includes('Unable to start a transaction in the given time') ||
    err.message.includes('cannot be executed on an expired transaction')
  );
}

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
 * model query), P2028 only for its maxWait / expired-timeout subtypes, P2010 with
 * `meta.driverAdapterError` (a raw query), or a bare DriverAdapterError (a
 * 40P01 on a model query — the client rethrows it unwrapped). Pure.
 */
export function isTransientConflict(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (TRANSIENT_PRISMA_CODES.has(err.code)) return true;
    if (err.code === 'P2028') return isRetryableP2028(err);
    const code = driverAdapterCode(
      (err.meta as { driverAdapterError?: unknown } | undefined)
        ?.driverAdapterError,
    );
    return code !== undefined && TRANSIENT_PG_CODES.has(code);
  }
  const code = driverAdapterCode(err);
  return code !== undefined && TRANSIENT_PG_CODES.has(code);
}

/** Postgres SQLSTATEs for a CHECK (23514) or NOT NULL (23502) violation that
 *  reached the database: a service-validation gap, answered as the generic
 *  422 below (no SQL / constraint names leak). Primary validation stays in
 *  the services — this is only a backstop. */
const CONSTRAINT_PG_CODES = new Set(['23514', '23502']);

/** Envelope for a CHECK / NOT NULL violation (see CONSTRAINT_PG_CODES). */
export const CONSTRAINT_VIOLATION = {
  status: 422,
  code: 'VALIDATION_FAILED',
  message: 'The request violates a data constraint',
} as const;

/**
 * True for a Postgres CHECK / NOT NULL violation however Prisma 7 + the pg
 * adapter surfaces it: P2011 (a NOT NULL on a model query — the adapter maps
 * 23502 to NullConstraintViolation), P2010 / P2039 carrying
 * `meta.driverAdapterError` with originalCode 23514/23502 (raw / model
 * query), or a bare DriverAdapterError (the client rethrows some unwrapped).
 * Pure.
 */
export function isConstraintViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2011') return true;
    const code = driverAdapterCode(
      (err.meta as { driverAdapterError?: unknown } | undefined)
        ?.driverAdapterError,
    );
    return code !== undefined && CONSTRAINT_PG_CODES.has(code);
  }
  const code = driverAdapterCode(err);
  return code !== undefined && CONSTRAINT_PG_CODES.has(code);
}

/** The violated constraint's name for server-side logs / Sentry tags (never
 *  the response): Postgres' `constraint "<name>"` text, or a trigger's
 *  `<name>: …` message prefix (e.g. `journal_entry_balanced`), read from the
 *  driver-adapter error's originalMessage or the error message. Pure. */
export function constraintNameOf(err: unknown): string | undefined {
  const texts: string[] = [];
  const collect = (e: unknown) => {
    if (typeof e !== 'object' || e === null) return;
    const { message, cause } = e as { message?: unknown; cause?: unknown };
    if (cause && typeof cause === 'object') {
      const om = (cause as { originalMessage?: unknown }).originalMessage;
      if (typeof om === 'string') texts.push(om);
    }
    if (typeof message === 'string') texts.push(message);
  };
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    collect(
      (err.meta as { driverAdapterError?: unknown } | undefined)
        ?.driverAdapterError,
    );
  }
  collect(err);
  for (const t of texts) {
    const quoted = /constraint "([^"]+)"/.exec(t);
    if (quoted) return quoted[1];
    const prefixed = /^([a-z_][a-z0-9_]*): /.exec(t);
    if (prefixed) return prefixed[1];
  }
  return undefined;
}

/** Envelope for a request body over the parser's size cap (1 MB, main.ts). */
export const PAYLOAD_TOO_LARGE = {
  status: 413,
  code: 'PAYLOAD_TOO_LARGE',
  message: 'Request body is too large',
} as const;

/** body-parser error types for an over-limit request: the body exceeds the
 *  byte `limit` (`entity.too.large`) or the urlencoded parameter count
 *  (`parameters.too.many`). */
const PAYLOAD_TOO_LARGE_TYPES = new Set([
  'entity.too.large',
  'parameters.too.many',
]);

/** True for body-parser's over-limit error (an `http-errors` 413, not an
 *  HttpException: Nest passes it to the filter unmapped). Pure. */
export function isPayloadTooLarge(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { type, status } = err as { type?: unknown; status?: unknown };
  return (
    typeof type === 'string' &&
    PAYLOAD_TOO_LARGE_TYPES.has(type) &&
    status === 413
  );
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
  if (isConstraintViolation(err)) return CONSTRAINT_VIOLATION.status;
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return PRISMA_STATUS[err.code]?.status ?? 500;
  }
  if (err instanceof Prisma.PrismaClientValidationError) return 400;
  if (isPayloadTooLarge(err)) return PAYLOAD_TOO_LARGE.status;
  return 500;
}
