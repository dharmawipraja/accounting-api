import { HttpException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CONSTRAINT_VIOLATION,
  constraintNameOf,
  isConstraintViolation,
  isBodyParserClientError,
  isTransientConflict,
  statusFromException,
  PRISMA_STATUS,
  TRANSIENT_CONFLICT,
} from './exception-status';
import {
  ConflictDomainError,
  ValidationFailedError,
  PasswordChangeRequiredError,
} from './domain-errors';

describe('statusFromException', () => {
  it('maps a DomainError to its own .status', () => {
    expect(statusFromException(new ConflictDomainError('dup'))).toBe(409);
    expect(statusFromException(new ValidationFailedError('bad'))).toBe(422);
  });

  it('maps PasswordChangeRequiredError to 403', () => {
    expect(
      statusFromException(new PasswordChangeRequiredError('change it')),
    ).toBe(403);
  });

  it('maps an HttpException to its getStatus()', () => {
    expect(statusFromException(new NotFoundException())).toBe(404);
    expect(statusFromException(new HttpException('teapot', 418))).toBe(418);
  });

  it('maps P2020 (value out of range, e.g. numeric overflow) to 400', () => {
    // A >16-integer-digit money value that slips past DTO validation must
    // degrade to a client error, not a 500 + Sentry incident.
    expect(PRISMA_STATUS.P2020).toEqual({
      status: 400,
      code: 'INVALID_INPUT',
      message: 'Value out of range',
    });
  });

  it('maps each known Prisma code per PRISMA_STATUS', () => {
    for (const [code, { status }] of Object.entries(PRISMA_STATUS)) {
      const err = new Prisma.PrismaClientKnownRequestError('m', {
        code,
        clientVersion: Prisma.prismaVersion.client,
      });
      expect(statusFromException(err)).toBe(status);
    }
  });

  it('maps an unmapped Prisma known code to 500', () => {
    const err = new Prisma.PrismaClientKnownRequestError('m', {
      code: 'P2037',
      clientVersion: Prisma.prismaVersion.client,
    });
    expect(statusFromException(err)).toBe(500);
  });

  it('maps a PrismaClientValidationError to 400', () => {
    const err = new Prisma.PrismaClientValidationError('m', {
      clientVersion: Prisma.prismaVersion.client,
    });
    expect(statusFromException(err)).toBe(400);
  });

  it('maps anything else to 500', () => {
    expect(statusFromException(new Error('boom'))).toBe(500);
    expect(statusFromException('nope')).toBe(500);
    expect(statusFromException(undefined)).toBe(500);
  });
});

describe('isTransientConflict (deadlock / serialization failure)', () => {
  const known = (code: string, meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('m', {
      code,
      clientVersion: 'test',
      meta,
    });
  // Shapes observed from Prisma 7.8 + @prisma/adapter-pg against real Postgres.
  const adapterErr = (code: string) => {
    const e = new Error('deadlock detected') as Error & { cause: unknown };
    e.name = 'DriverAdapterError';
    e.cause = { originalCode: code, kind: 'postgres', code };
    return e;
  };

  it('P2034 (40001 on a model query) is transient → 409', () => {
    expect(isTransientConflict(known('P2034'))).toBe(true);
    expect(statusFromException(known('P2034'))).toBe(409);
  });

  it('P2010 carrying 40P01/40001 (raw query) is transient → 409', () => {
    for (const code of ['40P01', '40001']) {
      const err = known('P2010', { driverAdapterError: adapterErr(code) });
      expect(isTransientConflict(err)).toBe(true);
      expect(statusFromException(err)).toBe(409);
    }
  });

  it('a bare DriverAdapterError 40P01 (model query) is transient → 409', () => {
    expect(isTransientConflict(adapterErr('40P01'))).toBe(true);
    expect(statusFromException(adapterErr('40P01'))).toBe(409);
  });

  it('a lock timeout (55P03 lock_not_available) is transient → 409, raw or model query', () => {
    const raw = known('P2010', { driverAdapterError: adapterErr('55P03') });
    expect(isTransientConflict(raw)).toBe(true);
    expect(statusFromException(raw)).toBe(409);
    expect(isTransientConflict(adapterErr('55P03'))).toBe(true);
    expect(statusFromException(adapterErr('55P03'))).toBe(409);
  });

  it('a statement timeout (57014 query_canceled) is transient → 409: raw (P2010), model (P2039) or bare', () => {
    // Shapes observed from Prisma 7.8 + adapter-pg against real Postgres with
    // `SET LOCAL statement_timeout`: raw → P2010, model query → P2039, both with
    // meta.driverAdapterError.
    const raw = known('P2010', { driverAdapterError: adapterErr('57014') });
    const model = known('P2039', {
      modelName: 'Account',
      driverAdapterError: adapterErr('57014'),
    });
    for (const err of [raw, model, adapterErr('57014')]) {
      expect(isTransientConflict(err)).toBe(true);
      expect(statusFromException(err)).toBe(409);
    }
  });

  // Shapes observed from Prisma 7.8 + @prisma/adapter-pg against real Postgres.
  const p2028 = (message: string, meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError(message, {
      code: 'P2028',
      clientVersion: 'test',
      meta,
    });

  it('P2028 expired interactive tx (query or commit past `timeout`) is transient → 409', () => {
    // Prisma closed and rolled back the tx; nothing committed, a same-key retry is safe.
    for (const operation of ['query', 'commit']) {
      const e = p2028(
        `Transaction API error: A ${operation} cannot be executed on an expired transaction. The timeout for this transaction was 100 ms, however 303 ms passed since the start of the transaction.`,
        { operation, timeout: 100, timeTaken: 303 },
      );
      expect(isTransientConflict(e)).toBe(true);
      expect(statusFromException(e)).toBe(409);
    }
  });

  it('P2028 unable to start within `maxWait` is transient → 409', () => {
    const e = p2028(
      'Transaction API error: Unable to start a transaction in the given time.',
      {},
    );
    expect(isTransientConflict(e)).toBe(true);
    expect(statusFromException(e)).toBe(409);
  });

  it('other P2028 subtypes are NOT retryable (a closed/committed tx may have committed)', () => {
    for (const msg of [
      'Transaction API error: Transaction already closed: A query cannot be executed on a committed transaction.',
      'Transaction API error: Transaction already closed: A query cannot be executed on a transaction that was rolled back.',
      "Transaction API error: Transaction not found. Transaction ID is invalid, refers to an old closed transaction Prisma doesn't have information about anymore, or was obtained before disconnecting.",
      'Transaction API error: Internal Consistency Error: x',
    ]) {
      const e = p2028(msg, {});
      expect(isTransientConflict(e)).toBe(false);
      expect(statusFromException(e)).toBe(500);
    }
    expect(isTransientConflict(known('P2028'))).toBe(false);
  });

  it('other codes and errors are not transient', () => {
    expect(isTransientConflict(known('P2002'))).toBe(false);
    expect(
      isTransientConflict(
        known('P2010', { driverAdapterError: adapterErr('23505') }),
      ),
    ).toBe(false);
    expect(isTransientConflict(known('P2010'))).toBe(false);
    expect(isTransientConflict(adapterErr('23505'))).toBe(false);
    expect(isTransientConflict(new Error('deadlock detected'))).toBe(false);
    expect(isTransientConflict(null)).toBe(false);
    expect(statusFromException(adapterErr('23505'))).toBe(500);
  });

  it('envelope is CONFLICT with retryable: true', () => {
    expect(TRANSIENT_CONFLICT).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      details: { retryable: true },
    });
  });
});

describe('isConstraintViolation (23514 / 23502 backstop → 422)', () => {
  const known = (code: string, meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('m', {
      code,
      clientVersion: Prisma.prismaVersion.client,
      meta,
    });
  const adapter = (originalCode: string, kind = 'postgres') => {
    const e = new Error('adapter') as Error & { cause: unknown };
    e.name = 'DriverAdapterError';
    e.cause = { kind, originalCode, originalMessage: 'violates check' };
    return e;
  };

  it('matches P2011 (NOT NULL on a model query)', () => {
    expect(isConstraintViolation(known('P2011'))).toBe(true);
    expect(statusFromException(known('P2011'))).toBe(422);
  });

  it('matches P2010 / P2039 carrying a 23514 or 23502 driverAdapterError', () => {
    for (const code of ['P2010', 'P2039']) {
      for (const pg of ['23514', '23502']) {
        const err = known(code, { driverAdapterError: adapter(pg) });
        expect(isConstraintViolation(err)).toBe(true);
        expect(statusFromException(err)).toBe(CONSTRAINT_VIOLATION.status);
      }
    }
  });

  it('matches a bare DriverAdapterError 23514 / 23502', () => {
    expect(isConstraintViolation(adapter('23514'))).toBe(true);
    expect(
      isConstraintViolation(adapter('23502', 'NullConstraintViolation')),
    ).toBe(true);
    expect(statusFromException(adapter('23514'))).toBe(422);
  });

  it('does not match other SQLSTATEs / codes (23505, 23000, P2002, plain Error)', () => {
    expect(isConstraintViolation(adapter('23505'))).toBe(false);
    expect(isConstraintViolation(adapter('23000'))).toBe(false);
    expect(
      isConstraintViolation(
        known('P2010', { driverAdapterError: adapter('23000') }),
      ),
    ).toBe(false);
    expect(isConstraintViolation(known('P2002'))).toBe(false);
    expect(isConstraintViolation(new Error('x'))).toBe(false);
    expect(statusFromException(adapter('23000'))).toBe(500);
  });
});

describe('isBodyParserClientError (body-parser / http-errors 4xx)', () => {
  const parserError = (type: string, status: number, message = 'x') =>
    Object.assign(new Error(message), {
      type,
      status,
      statusCode: status,
      expose: true,
    });

  it('matches 413 entity.too.large and parameters.too.many', () => {
    expect(isBodyParserClientError(parserError('entity.too.large', 413))).toBe(
      true,
    );
    expect(
      isBodyParserClientError(parserError('parameters.too.many', 413)),
    ).toBe(true);
    expect(statusFromException(parserError('entity.too.large', 413))).toBe(413);
  });

  it('matches 415 charset.unsupported / encoding.unsupported with their status', () => {
    for (const type of ['charset.unsupported', 'encoding.unsupported']) {
      expect(isBodyParserClientError(parserError(type, 415))).toBe(true);
      expect(statusFromException(parserError(type, 415))).toBe(415);
    }
  });

  it('matches 400 request.aborted (status read from statusCode alone too)', () => {
    expect(statusFromException(parserError('request.aborted', 400))).toBe(400);
    const onlyStatusCode = Object.assign(new Error('aborted'), {
      type: 'request.aborted',
      statusCode: 400,
    });
    expect(isBodyParserClientError(onlyStatusCode)).toBe(true);
    expect(statusFromException(onlyStatusCode)).toBe(400);
  });

  it('iter6: matches an untyped http-errors 4xx (zlib Z_DATA_ERROR wrapped by createError(400, err)) only with expose === true', () => {
    // body-parser 2.x wraps a decompression failure as createError(400, err):
    // the zlib error keeps its own props (code Z_DATA_ERROR, errno) and gains
    // status/statusCode 400 + expose true, but NO `type`.
    const zlib = Object.assign(new Error('incorrect header check'), {
      code: 'Z_DATA_ERROR',
      errno: -3,
      status: 400,
      statusCode: 400,
      expose: true,
    });
    expect(isBodyParserClientError(zlib)).toBe(true);
    expect(statusFromException(zlib)).toBe(400);
    // Same shape without expose === true (an app error carrying a status) is
    // not a parser error.
    for (const expose of [undefined, false, 'true', 1]) {
      const e = Object.assign(new Error('x'), {
        status: 400,
        statusCode: 400,
        expose,
      });
      expect(isBodyParserClientError(e)).toBe(false);
      expect(statusFromException(e)).toBe(500);
    }
    // expose true but a 5xx / non-integer status never matches.
    expect(
      isBodyParserClientError(
        Object.assign(new Error('x'), { status: 500, expose: true }),
      ),
    ).toBe(false);
    expect(
      isBodyParserClientError(
        Object.assign(new Error('x'), { status: 400.5, expose: true }),
      ),
    ).toBe(false);
  });

  it('does not match non-4xx, untyped or non-object shapes', () => {
    expect(
      isBodyParserClientError(parserError('stream.not.readable', 500)),
    ).toBe(false);
    expect(statusFromException(parserError('stream.not.readable', 500))).toBe(
      500,
    );
    expect(
      isBodyParserClientError(Object.assign(new Error('x'), { status: 400 })),
    ).toBe(false);
    expect(
      isBodyParserClientError(
        Object.assign(new Error('x'), { type: 'a', status: '400' }),
      ),
    ).toBe(false);
    expect(isBodyParserClientError(null)).toBe(false);
    expect(isBodyParserClientError('entity.too.large')).toBe(false);
  });
});

describe('constraintNameOf', () => {
  it('reads a quoted constraint, a trigger prefix, or nothing', () => {
    const adapter = (originalMessage: string) =>
      Object.assign(new Error('adapter'), {
        name: 'DriverAdapterError',
        cause: { originalCode: '23514', originalMessage },
      });
    expect(
      constraintNameOf(
        adapter('new row violates check constraint "journal_lines_one_sided"'),
      ),
    ).toBe('journal_lines_one_sided');
    expect(
      constraintNameOf(
        new Prisma.PrismaClientKnownRequestError('m', {
          code: 'P2010',
          clientVersion: Prisma.prismaVersion.client,
          meta: {
            driverAdapterError: adapter('journal_entry_balanced: unbalanced'),
          },
        }),
      ),
    ).toBe('journal_entry_balanced');
    expect(constraintNameOf(new Error('Something else'))).toBeUndefined();
    expect(constraintNameOf(null)).toBeUndefined();
  });
});
