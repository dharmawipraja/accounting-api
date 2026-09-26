jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));
import * as Sentry from '@sentry/node';
import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { ConflictDomainError } from '../errors/domain-errors';
import { RejectionAuditLimiter } from '../../audit/rejection-audit-limiter';

function mockHost(): {
  host: ArgumentsHost;
  payload: () => unknown;
  code: () => number;
} {
  let body: unknown;
  let statusCode = 0;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(b: unknown) {
      body = b;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ url: '/test', id: 'req-1' }),
    }),
  } as unknown as ArgumentsHost;
  return { host, payload: () => body, code: () => statusCode };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  it('maps a DomainError to its status and code', () => {
    const m = mockHost();
    filter.catch(
      new ConflictDomainError('email taken', { email: 'a@b.c' }),
      m.host,
    );
    expect(m.code()).toBe(409);
    expect(m.payload()).toMatchObject({
      code: 'CONFLICT',
      message: 'email taken',
      details: { email: 'a@b.c' },
    });
  });

  it('stamps the request id (req.id) into the envelope as traceId', () => {
    const m = mockHost(); // getRequest() returns { id: 'req-1' }
    filter.catch(new ConflictDomainError('x', {}), m.host);
    expect((m.payload() as { traceId?: string }).traceId).toBe('req-1');
  });

  it('maps a NestJS HttpException', () => {
    const m = mockHost();
    filter.catch(new HttpException('nope', 400), m.host);
    expect(m.code()).toBe(400);
    expect(m.payload()).toMatchObject({ code: 'HTTP_400', message: 'nope' });
  });

  it('preserves validation error arrays in details', () => {
    const m = mockHost();
    filter.catch(
      new BadRequestException([
        'name must be a string',
        'email must be an email',
      ]),
      m.host,
    );
    expect(m.code()).toBe(400);
    expect(m.payload()).toMatchObject({
      code: 'HTTP_400',
      message: 'Validation failed',
      details: { errors: ['name must be a string', 'email must be an email'] },
    });
  });

  it('maps an unknown error to 500 without leaking internals', () => {
    const m = mockHost();
    filter.catch(new Error('boom secret'), m.host);
    expect(m.code()).toBe(500);
    expect(m.payload()).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  });

  it('maps Prisma P2025 (not found) to 404 NOT_FOUND without leaking meta', () => {
    const m = mockHost();
    const err = new Prisma.PrismaClientKnownRequestError(
      'Record to update not found.',
      {
        code: 'P2025',
        clientVersion: Prisma.prismaVersion.client,
        meta: { modelName: 'SalesInvoice', target: ['code'] },
      },
    );
    filter.catch(err, m.host);
    expect(m.code()).toBe(404);
    const body = m.payload() as { code: string; message: string };
    expect(body.code).toBe('NOT_FOUND');
    expect(JSON.stringify(body)).not.toContain('SalesInvoice'); // no schema leak
    expect(JSON.stringify(body)).not.toContain('target');
  });

  it('maps Prisma P2002 (unique) to 409 CONFLICT', () => {
    const m = mockHost();
    const err = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      {
        code: 'P2002',
        clientVersion: Prisma.prismaVersion.client,
        meta: { target: ['code'] },
      },
    );
    filter.catch(err, m.host);
    expect(m.code()).toBe(409);
    expect((m.payload() as { code: string }).code).toBe('CONFLICT');
  });

  it('maps Prisma P2023 (malformed UUID) to 400 INVALID_INPUT', () => {
    const m = mockHost();
    const err = new Prisma.PrismaClientKnownRequestError(
      'Inconsistent column data',
      {
        code: 'P2023',
        clientVersion: Prisma.prismaVersion.client,
      },
    );
    filter.catch(err, m.host);
    expect(m.code()).toBe(400);
    expect((m.payload() as { code: string }).code).toBe('INVALID_INPUT');
  });

  it('maps a PrismaClientValidationError to 400 INVALID_INPUT', () => {
    const m = mockHost();
    const err = new Prisma.PrismaClientValidationError(
      'Invalid `prisma.x` invocation',
      {
        clientVersion: Prisma.prismaVersion.client,
      },
    );
    filter.catch(err, m.host);
    expect(m.code()).toBe(400);
    expect((m.payload() as { code: string }).code).toBe('INVALID_INPUT');
  });

  it('maps a deadlock (bare DriverAdapterError 40P01) to 409 CONFLICT retryable, no Sentry', () => {
    (Sentry.captureException as jest.Mock).mockClear();
    const m = mockHost();
    const err = new Error('deadlock detected') as Error & { cause: unknown };
    err.name = 'DriverAdapterError';
    err.cause = { originalCode: '40P01', kind: 'postgres', code: '40P01' };
    filter.catch(err, m.host);
    expect(m.code()).toBe(409);
    expect(m.payload()).toMatchObject({
      code: 'CONFLICT',
      details: { retryable: true },
    });
    expect(Sentry.captureException as jest.Mock).not.toHaveBeenCalled();
  });

  it('maps a CHECK violation (P2010 + 23514) to 422 VALIDATION_FAILED without leaking SQL, Sentry warning captured', () => {
    (Sentry.captureException as jest.Mock).mockClear();
    const m = mockHost();
    const adapterErr = Object.assign(new Error('adapter'), {
      name: 'DriverAdapterError',
      cause: {
        kind: 'postgres',
        originalCode: '23514',
        originalMessage:
          'new row for relation "payment_allocations" violates check constraint "payment_allocations_amount_positive"',
      },
    });
    const err = new Prisma.PrismaClientKnownRequestError(
      'Database error. Code: `23514`. payment_allocations_amount_positive',
      {
        code: 'P2010',
        clientVersion: Prisma.prismaVersion.client,
        meta: { driverAdapterError: adapterErr },
      },
    );
    filter.catch(err, m.host);
    expect(m.code()).toBe(422);
    expect(m.payload()).toEqual({
      code: 'VALIDATION_FAILED',
      message: 'The request violates a data constraint',
      traceId: 'req-1',
    });
    // A backstop hit is a validation gap (code defect): reported at warning.
    expect(Sentry.captureException as jest.Mock).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException as jest.Mock).toHaveBeenCalledWith(err, {
      level: 'warning',
      tags: {
        kind: 'constraint-backstop',
        constraint: 'payment_allocations_amount_positive',
        traceId: 'req-1',
      },
      extra: { path: '/test' },
    });
  });

  it('reports the deferred journal_entry_balanced trigger (bare 23514) with its name', () => {
    (Sentry.captureException as jest.Mock).mockClear();
    const m = mockHost();
    const err = Object.assign(new Error('adapter'), {
      name: 'DriverAdapterError',
      cause: {
        kind: 'postgres',
        originalCode: '23514',
        originalMessage:
          'journal_entry_balanced: posted journal entry 1 is unbalanced (debit 1, credit 2)',
      },
    });
    filter.catch(err, m.host);
    expect(m.code()).toBe(422);
    expect(JSON.stringify(m.payload())).not.toContain('journal_entry_balanced');
    expect(Sentry.captureException as jest.Mock).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          kind: 'constraint-backstop',
          constraint: 'journal_entry_balanced',
        }) as unknown,
      }),
    );
  });

  it('ordinary 4xx (DomainError 422, HttpException 400, P2002 409) never reach Sentry', () => {
    (Sentry.captureException as jest.Mock).mockClear();
    const errs = [
      new ConflictDomainError('x'),
      new BadRequestException('bad'),
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: Prisma.prismaVersion.client,
      }),
    ];
    for (const err of errs) filter.catch(err, mockHost().host);
    expect(Sentry.captureException as jest.Mock).not.toHaveBeenCalled();
  });

  it('maps a NOT NULL violation (P2011 / bare DriverAdapterError 23502) to 422', () => {
    const p2011 = new Prisma.PrismaClientKnownRequestError('null', {
      code: 'P2011',
      clientVersion: Prisma.prismaVersion.client,
    });
    const bare = Object.assign(new Error('null value'), {
      name: 'DriverAdapterError',
      cause: { kind: 'NullConstraintViolation', originalCode: '23502' },
    });
    for (const err of [p2011, bare]) {
      const m = mockHost();
      filter.catch(err, m.host);
      expect(m.code()).toBe(422);
      expect((m.payload() as { code: string }).code).toBe('VALIDATION_FAILED');
    }
  });

  it('maps a body-parser entity.too.large to 413 PAYLOAD_TOO_LARGE, no Sentry', () => {
    (Sentry.captureException as jest.Mock).mockClear();
    const m = mockHost();
    const err = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
      status: 413,
      statusCode: 413,
      expose: true,
    });
    filter.catch(err, m.host);
    expect(m.code()).toBe(413);
    expect(m.payload()).toEqual({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body is too large',
      traceId: 'req-1',
    });
    expect(Sentry.captureException as jest.Mock).not.toHaveBeenCalled();
  });

  it('iter6: maps an untyped http-errors 400 (zlib Z_DATA_ERROR from gzip junk) to 400, no Sentry', () => {
    (Sentry.captureException as jest.Mock).mockClear();
    const m = mockHost();
    const err = Object.assign(new Error('incorrect header check'), {
      code: 'Z_DATA_ERROR',
      errno: -3,
      status: 400,
      statusCode: 400,
      expose: true,
    });
    filter.catch(err, m.host);
    expect(m.code()).toBe(400);
    expect(m.payload()).toEqual({
      code: 'HTTP_400',
      message: 'incorrect header check',
      traceId: 'req-1',
    });
    expect(Sentry.captureException as jest.Mock).not.toHaveBeenCalled();
  });

  it('maps other body-parser client errors (415 charset/encoding, 400 aborted) to their status, no Sentry', () => {
    (Sentry.captureException as jest.Mock).mockClear();
    const cases = [
      {
        type: 'charset.unsupported',
        status: 415,
        message: 'unsupported charset "UTF-7"',
      },
      {
        type: 'encoding.unsupported',
        status: 415,
        message: 'unsupported content encoding "br2"',
      },
      { type: 'request.aborted', status: 400, message: 'request aborted' },
    ];
    for (const c of cases) {
      const m = mockHost();
      const err = Object.assign(new Error(c.message), {
        type: c.type,
        status: c.status,
        statusCode: c.status,
        expose: true,
      });
      filter.catch(err, m.host);
      expect(m.code()).toBe(c.status);
      expect(m.payload()).toEqual({
        code: `HTTP_${c.status}`,
        message: c.message,
        traceId: 'req-1',
      });
    }
    expect(Sentry.captureException as jest.Mock).not.toHaveBeenCalled();
  });

  it('never echoes a non-exposed body-parser message', () => {
    const m = mockHost();
    const err = Object.assign(new Error('internal detail'), {
      type: 'some.type',
      statusCode: 400,
      expose: false,
    });
    filter.catch(err, m.host);
    expect(m.code()).toBe(400);
    expect(m.payload()).toEqual({
      code: 'HTTP_400',
      message: 'Bad request',
      traceId: 'req-1',
    });
  });

  it('maps Prisma P2034 (write conflict) to 409 CONFLICT retryable', () => {
    const m = mockHost();
    const err = new Prisma.PrismaClientKnownRequestError('conflict', {
      code: 'P2034',
      clientVersion: Prisma.prismaVersion.client,
    });
    filter.catch(err, m.host);
    expect(m.code()).toBe(409);
    expect(m.payload()).toMatchObject({
      code: 'CONFLICT',
      details: { retryable: true },
    });
  });

  it('leaves an unmapped Prisma code as 500 INTERNAL_ERROR and reports it to Sentry', () => {
    (Sentry.captureException as jest.Mock).mockClear();
    const m = mockHost();
    const err = new Prisma.PrismaClientKnownRequestError('boom', {
      code: 'P2037',
      clientVersion: Prisma.prismaVersion.client,
    });
    filter.catch(err, m.host);
    expect(m.code()).toBe(500);
    expect((m.payload() as { code: string }).code).toBe('INTERNAL_ERROR');
    expect(Sentry.captureException as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('reports a 500/unknown error to Sentry with the traceId tag and path', () => {
    (Sentry.captureException as jest.Mock).mockClear();
    const m = mockHost();
    const err = new Error('boom');
    filter.catch(err, m.host);
    expect(m.code()).toBe(500);
    expect(Sentry.captureException as jest.Mock).toHaveBeenCalledTimes(1);
    // the trace tag must be req.id (not the URL) so incidents are correlatable
    expect(Sentry.captureException as jest.Mock).toHaveBeenCalledWith(err, {
      tags: { traceId: 'req-1' },
      extra: { path: '/test' },
    });
  });

  it('does NOT report a mapped 4xx (DomainError) to Sentry', () => {
    (Sentry.captureException as jest.Mock).mockClear();
    const m = mockHost();
    filter.catch(new ConflictDomainError('dup', {}), m.host);
    expect(m.code()).toBe(409);
    expect(Sentry.captureException as jest.Mock).not.toHaveBeenCalled();
  });

  it('falls back to "unknown" URL when req.url is absent', () => {
    // Exercises the `req.url ?? 'unknown'` branch (line 29).
    let body: unknown;
    const res = {
      status(_code: number) {
        return this;
      },
      json(b: unknown) {
        body = b;
        return this;
      },
    };
    // Request has no url property — only id
    const host = {
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => ({ id: 'req-2' }),
      }),
    } as unknown as ArgumentsHost;
    // Should not throw — falls back to 'unknown' URL for logging
    expect(() =>
      filter.catch(new ConflictDomainError('x', {}), host),
    ).not.toThrow();
    expect((body as { code: string }).code).toBe('CONFLICT');
  });

  it('handles a thrown non-Error value (string) as a 500 without crashing', () => {
    // Exercises the `String(exception)` branch in the else block (lines 88-96).
    const m = mockHost();
    filter.catch('something went wrong', m.host);
    expect(m.code()).toBe(500);
    expect((m.payload() as { code: string }).code).toBe('INTERNAL_ERROR');
  });

  it('uses exception.message as fallback when HttpException response object has no message field', () => {
    // Exercises the `rawMessage ?? exception.message` branch (line 58):
    // getResponse() returns an object with no `message` key.
    const m = mockHost();
    const err = new HttpException({ error: 'Gone' }, 410);
    filter.catch(err, m.host);
    expect(m.code()).toBe(410);
    const body = m.payload() as { code: string; message: string };
    expect(body.code).toBe('HTTP_410');
    // message falls back to exception.message (NestJS default: "HTTP Exception")
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
  });

  it('omits traceId from envelope when req.id is absent (line 96)', () => {
    // Exercises the falsy branch of `if (req.id) envelope.traceId = req.id`.
    let body: unknown;
    const res = {
      status(_code: number) {
        return this;
      },
      json(b: unknown) {
        body = b;
        return this;
      },
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => ({ url: '/test' }), // no id
      }),
    } as unknown as ArgumentsHost;
    filter.catch(new ConflictDomainError('x', {}), host);
    expect((body as Record<string, unknown>).traceId).toBeUndefined();
  });
});

describe('AllExceptionsFilter guard-rejection audit', () => {
  function hostFor(req: Record<string, unknown>) {
    let statusCode = 0;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json() {
        return this;
      },
    };
    const host = {
      switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
    } as unknown as ArgumentsHost;
    return { host, code: () => statusCode };
  }
  const flush = () => new Promise((r) => setImmediate(r));

  it('audits a guard 401 on a mutating request without the body, then responds', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const filter = new AllExceptionsFilter({ record });
    const req = {
      method: 'POST',
      url: '/v1/partners',
      params: {},
      body: { name: 'x' },
      id: 'srv-1',
      clientRequestId: 'cli-1',
    };
    const m = hostFor(req);
    filter.catch(new HttpException('Unauthorized', 401), m.host);
    await flush();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 401,
        body: {},
        userId: null,
        requestId: 'srv-1',
        clientRequestId: 'cli-1',
      }),
    );
    expect(m.code()).toBe(401);
  });

  it('keeps the redacted body for a 403 and never double-audits', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const filter = new AllExceptionsFilter({ record });
    const req = {
      method: 'PATCH',
      url: '/v1/x',
      params: {},
      body: { password: 'p' },
      user: { id: 'u1', role: 'VIEWER' },
    };
    filter.catch(new HttpException('Forbidden', 403), hostFor(req).host);
    await flush();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 403,
        body: { password: '[REDACTED]' },
        userId: 'u1',
      }),
    );
    // same request object reaching the filter again → already audited
    filter.catch(new HttpException('Forbidden', 403), hostFor(req).host);
    await flush();
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('does not audit reads or non-guard statuses', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const filter = new AllExceptionsFilter({ record });
    const get = hostFor({ method: 'GET', url: '/v1/x', params: {} });
    filter.catch(new HttpException('Unauthorized', 401), get.host);
    const notFound = hostFor({ method: 'POST', url: '/v1/nope', params: {} });
    filter.catch(new HttpException('Not Found', 404), notFound.host);
    await flush();
    expect(record).not.toHaveBeenCalled();
    expect(get.code()).toBe(401);
    expect(notFound.code()).toBe(404);
  });
  it('responds first; a failing or throwing audit write is swallowed (no unhandled rejection)', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      for (const record of [
        jest.fn().mockRejectedValue(new Error('db down')),
        jest.fn(() => {
          throw new Error('sync boom');
        }),
        jest.fn(() => new Promise<void>(() => undefined)), // hangs forever
      ]) {
        const filter = new AllExceptionsFilter({ record });
        const m = hostFor({ method: 'POST', url: '/v1/x', params: {} });
        filter.catch(new HttpException('Unauthorized', 401), m.host);
        expect(m.code()).toBe(401); // sent synchronously, before the write settles
        expect(record).toHaveBeenCalledTimes(1);
      }
      await flush();
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('AUDIT3-17: an anonymous 429 stores no body; an authenticated 429 keeps it', async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const filter = new AllExceptionsFilter({ record });
    filter.catch(
      new HttpException('Too Many Requests', 429),
      hostFor({
        method: 'POST',
        url: '/v1/auth/login',
        params: {},
        body: { email: 'a@b.io', junk: 'x' },
      }).host,
    );
    filter.catch(
      new HttpException('Too Many Requests', 429),
      hostFor({
        method: 'POST',
        url: '/v1/partners',
        params: {},
        body: { name: 'n' },
        user: { id: 'u1', role: 'ADMIN' },
      }).host,
    );
    await flush();
    expect(record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ statusCode: 429, body: {}, userId: null }),
    );
    expect(record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ statusCode: 429, body: { name: 'n' } }),
    );
  });

  it('authenticated rejections are capped per user, not by the client IP bucket', () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const filter = new AllExceptionsFilter(
      { record },
      new RejectionAuditLimiter({ limit: 1, userLimit: 2 }),
    );
    const fire = (user?: { id: string; role: string }) =>
      filter.catch(
        new HttpException('Forbidden', user ? 403 : 401),
        hostFor({
          method: 'POST',
          url: '/v1/x',
          params: {},
          ip: '5.5.5.5',
          user,
        }).host,
      );
    fire(); // anonymous: IP budget 1
    fire(); // suppressed
    fire({ id: 'u1', role: 'VIEWER' });
    fire({ id: 'u1', role: 'VIEWER' });
    fire({ id: 'u1', role: 'VIEWER' }); // suppressed (user cap 2)
    expect(record).toHaveBeenCalledTimes(3);
  });

  it('caps rejection rows per client IP', () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const filter = new AllExceptionsFilter(
      { record },
      new RejectionAuditLimiter({ limit: 2 }),
    );
    const fire = (ip: string) =>
      filter.catch(
        new HttpException('Unauthorized', 401),
        hostFor({ method: 'POST', url: '/v1/x', params: {}, ip }).host,
      );
    fire('1.1.1.1');
    fire('1.1.1.1');
    fire('1.1.1.1'); // suppressed
    fire('2.2.2.2');
    expect(record).toHaveBeenCalledTimes(3);
  });
});
