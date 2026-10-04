import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainError } from './domain-errors';

/**
 * Prisma known-request error code → HTTP envelope. The single source for how a
 * Prisma error becomes an HTTP status/code/message (read by `classifyException`).
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
  }
  const code = pgSqlStateOf(err);
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
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2011'
  )
    return true;
  const code = pgSqlStateOf(err);
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

/** The Postgres SQLSTATE behind `err` however Prisma 7 + the pg adapter
 *  surfaces it — a PrismaClientKnownRequestError carrying
 *  `meta.driverAdapterError`, or a bare DriverAdapterError — else undefined.
 *  Pure. */
export function pgSqlStateOf(err: unknown): string | undefined {
  return err instanceof Prisma.PrismaClientKnownRequestError
    ? driverAdapterCode(
        (err.meta as { driverAdapterError?: unknown } | undefined)
          ?.driverAdapterError,
      )
    : driverAdapterCode(err);
}

/** Postgres SQLSTATEs for a value the database cannot store as text:
 *  22021 character_not_in_repertoire (e.g. U+0000 — "invalid byte sequence
 *  for encoding UTF8: 0x00") and 22P05 untranslatable_character (e.g. a
 *  `\u0000` escape in jsonb). The InputHygieneGuard rejects such input
 *  up front; this is the backstop for any path it does not cover. */
const UNSTORABLE_PG_CODES = new Set(['22021', '22P05']);

/** Envelope for an unstorable-character value (see UNSTORABLE_PG_CODES) —
 *  the same code as the InputHygieneGuard's 400 INVALID_CHARACTERS. */
export const UNSTORABLE_CHARACTERS = {
  status: 400,
  code: 'INVALID_CHARACTERS',
  message: 'Request contains a character that cannot be stored',
} as const;

/** True for a Postgres 22021 / 22P05 however Prisma 7 + the pg adapter
 *  surfaces it: P2039 / P2010 carrying `meta.driverAdapterError` (model /
 *  raw query) or a bare DriverAdapterError. Pure. */
export function isUnstorableCharacters(err: unknown): boolean {
  const code = pgSqlStateOf(err);
  return code !== undefined && UNSTORABLE_PG_CODES.has(code);
}

/** Postgres SQLSTATE 22008 datetime_field_overflow: a date/time value
 *  outside what the column type accepts (e.g. year 0000 in an audit-log
 *  `?from=` filter — Prisma 7 surfaces it as P2039 carrying
 *  `meta.driverAdapterError`). The DTOs reject such values first
 *  (`@IsAuditInstant()`); this is the backstop so none becomes a 500. */
const OUT_OF_RANGE_PG_CODES = new Set(['22008']);

/** Envelope for an out-of-range value (see OUT_OF_RANGE_PG_CODES) — the
 *  same shape as a P2020 numeric overflow. */
export const VALUE_OUT_OF_RANGE = {
  status: 400,
  code: 'INVALID_INPUT',
  message: 'Value out of range',
} as const;

/** True for a Postgres 22008 however Prisma 7 + the pg adapter surfaces it
 *  (P2039 / P2010 with `meta.driverAdapterError`, or a bare
 *  DriverAdapterError). Pure. */
export function isValueOutOfRange(err: unknown): boolean {
  const code = pgSqlStateOf(err);
  return code !== undefined && OUT_OF_RANGE_PG_CODES.has(code);
}

/** Envelope for a request body over the parser's size cap (1 MB, main.ts). */
export const PAYLOAD_TOO_LARGE = {
  status: 413,
  code: 'PAYLOAD_TOO_LARGE',
  message: 'Request body is too large',
} as const;

/**
 * The 4xx status of a body-parser / `http-errors` client error, else
 * undefined. Such errors are not HttpExceptions — Nest passes them to the
 * filter unmapped — and are recognised by a string `type` (e.g.
 * `entity.too.large` / `parameters.too.many` 413, `charset.unsupported` /
 * `encoding.unsupported` 415, `request.aborted` 400) plus a numeric 4xx
 * `status` / `statusCode` — OR, without a `type`, by http-errors' own marker
 * `expose === true` plus a numeric 4xx status: body-parser wraps a
 * decompression failure (`Content-Encoding: gzip` + junk → zlib
 * `Z_DATA_ERROR`) as `createError(400, err)`, which keeps the zlib error's
 * props and adds status 400 + `expose: true` but no `type`. App errors never
 * reach here as such (HttpException / DomainError / Prisma are classified
 * first, and none sets `expose`). They are raised before routing (no guard
 * ran), so they are client errors, never incidents. Pure.
 */
function bodyParserClientStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { type, status, statusCode, expose } = err as {
    type?: unknown;
    status?: unknown;
    statusCode?: unknown;
    expose?: unknown;
  };
  if (typeof type !== 'string' && expose !== true) return undefined;
  const s = typeof status === 'number' ? status : statusCode;
  return typeof s === 'number' && Number.isInteger(s) && s >= 400 && s < 500
    ? s
    : undefined;
}

/** True for a body-parser / `http-errors` 4xx client error (see
 *  `bodyParserClientStatus`). Pure. */
export function isBodyParserClientError(err: unknown): boolean {
  return bodyParserClientStatus(err) !== undefined;
}

/** How `AllExceptionsFilter` answers, logs and reports one exception. */
interface ExceptionClass {
  status: number;
  envelope: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  /** Logger method + its arguments (built from the request URL); absent =
   *  not logged (DomainError / HttpException — expected outcomes). */
  log?: {
    level: 'log' | 'warn' | 'error';
    args: (url: string) => [message: string, ...rest: unknown[]];
  };
  /** Absent = not reported. The filter adds `traceId` / `path`. */
  sentry?: { level?: 'warning'; tags?: Record<string, string> };
}

const INTERNAL_ERROR = {
  status: 500,
  envelope: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
} as const;

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * THE exception classification — one ordered chain (first match wins) that
 * `AllExceptionsFilter` (response, log, Sentry) and `statusFromException`
 * (audit-row status) both read, so they can never disagree. Pure: it only
 * describes side effects; the filter performs them.
 */
export function classifyException(err: unknown): ExceptionClass {
  if (err instanceof DomainError) {
    return {
      status: err.status,
      envelope: { code: err.code, message: err.message, details: err.details },
    };
  }
  if (err instanceof HttpException) {
    const status = err.getStatus();
    const res = err.getResponse();
    if (typeof res === 'string') {
      return { status, envelope: { code: `HTTP_${status}`, message: res } };
    }
    const rawMessage = (res as { message?: string | string[] }).message;
    // class-validator (ValidationPipe) yields an array of per-field
    // messages — preserve them so the frontend can show field errors.
    return {
      status,
      envelope: Array.isArray(rawMessage)
        ? {
            code: `HTTP_${status}`,
            message: 'Validation failed',
            details: { errors: rawMessage },
          }
        : { code: `HTTP_${status}`, message: rawMessage ?? err.message },
    };
  }
  if (isTransientConflict(err)) {
    // Deadlock / serialization failure: the tx rolled back — a client retry
    // is safe. Expected under contention, so warn (no Sentry).
    const { status, code, message, details } = TRANSIENT_CONFLICT;
    return {
      status,
      envelope: { code, message, details: { ...details } },
      log: {
        level: 'warn',
        args: (url) => [
          `Transient transaction conflict -> ${status} on ${url}: ${messageOf(err)}`,
        ],
      },
    };
  }
  if (isConstraintViolation(err)) {
    // CHECK / NOT NULL violation that escaped service validation: a generic
    // 422 backstop (no SQL / constraint names in the response). It only
    // fires on a validation gap (a code defect — e.g. the deferred
    // journal_entry_balanced trigger), so it is logged at ERROR with the
    // constraint name and reported to Sentry at warning level.
    const { status, code, message } = CONSTRAINT_VIOLATION;
    const constraint = constraintNameOf(err) ?? 'unknown';
    return {
      status,
      envelope: { code, message },
      log: {
        level: 'error',
        args: (url) => [
          `Constraint violation (${constraint}) -> ${status} on ${url}: ${messageOf(err)}`,
        ],
      },
      sentry: {
        level: 'warning',
        tags: { kind: 'constraint-backstop', constraint },
      },
    };
  }
  if (isUnstorableCharacters(err)) {
    // A U+0000 / untranslatable character reached Postgres (22021/22P05):
    // client input, not an incident — 400 INVALID_CHARACTERS, warn only.
    const { status, code, message } = UNSTORABLE_CHARACTERS;
    return {
      status,
      envelope: { code, message },
      log: {
        level: 'warn',
        args: (url) => [
          `Unstorable character -> ${status} on ${url}: ${messageOf(err)}`,
        ],
      },
    };
  }
  if (isValueOutOfRange(err)) {
    // A date/time outside the column's range reached Postgres (22008):
    // answered 400 INVALID_INPUT, but the DTOs should have caught it (or a
    // server-computed date overflowed), so it is also a Sentry warning.
    const { status, code, message } = VALUE_OUT_OF_RANGE;
    return {
      status,
      envelope: { code, message },
      log: {
        level: 'warn',
        args: (url) => [
          `Value out of range -> ${status} on ${url}: ${messageOf(err)}`,
        ],
      },
      sentry: { level: 'warning', tags: { kind: 'datetime-overflow' } },
    };
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const mapped = PRISMA_STATUS[err.code];
    if (mapped) {
      const { status, code, message } = mapped;
      return {
        status,
        envelope: { code, message },
        log: {
          level: 'warn',
          args: (url) => [
            `Prisma ${err.code} -> ${status} on ${url}: ${err.message}`,
          ],
        },
      };
    }
    // Unknown Prisma code: stay 500 + INTERNAL_ERROR, but log loudly.
    return {
      ...INTERNAL_ERROR,
      log: {
        level: 'error',
        args: (url) => [`Unmapped Prisma ${err.code} on ${url}`, err.stack],
      },
      sentry: {},
    };
  }
  if (err instanceof Prisma.PrismaClientValidationError) {
    return {
      status: 400,
      envelope: { code: 'INVALID_INPUT', message: 'Invalid input' },
      log: {
        level: 'warn',
        args: (url) => [`Prisma validation error -> 400 on ${url}`],
      },
    };
  }
  const parserStatus = bodyParserClientStatus(err);
  if (parserStatus !== undefined) {
    // body-parser rejected the body before routing (over the size cap,
    // unsupported charset / encoding, aborted upload, corrupt gzip/deflate
    // stream): a client error, not an incident (info log, no Sentry, no
    // audit row — no guard ran).
    const { message, expose, type, code } = err as {
      message?: unknown;
      expose?: unknown;
      type?: unknown;
      code?: unknown;
    };
    const kind =
      typeof type === 'string'
        ? type
        : typeof code === 'string'
          ? code
          : 'untyped';
    return {
      status: parserStatus,
      envelope:
        parserStatus === PAYLOAD_TOO_LARGE.status
          ? { code: PAYLOAD_TOO_LARGE.code, message: PAYLOAD_TOO_LARGE.message }
          : {
              code: `HTTP_${parserStatus}`,
              // http-errors marks client-safe messages `expose: true`.
              message:
                expose === true && typeof message === 'string'
                  ? message
                  : 'Bad request',
            },
      log: {
        level: 'log',
        args: (url) => [
          `Request body rejected by the parser (${kind}) -> ${parserStatus} on ${url}`,
        ],
      },
    };
  }
  return {
    ...INTERNAL_ERROR,
    log: {
      level: 'error',
      args: (url) => [
        `Unhandled exception on ${url}`,
        err instanceof Error ? err.stack : String(err),
      ],
    },
    sentry: {},
  };
}

/** The HTTP status an exception maps to (see `classifyException`) — what
 *  `AuditInterceptor` records, identical to the filter's response status. */
export function statusFromException(err: unknown): number {
  return classifyException(err).status;
}
