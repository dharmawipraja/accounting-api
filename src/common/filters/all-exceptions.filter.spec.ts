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
