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

  it('leaves an unmapped Prisma code as 500 INTERNAL_ERROR', () => {
    const m = mockHost();
    const err = new Prisma.PrismaClientKnownRequestError('boom', {
      code: 'P2037',
      clientVersion: Prisma.prismaVersion.client,
    });
    filter.catch(err, m.host);
    expect(m.code()).toBe(500);
    expect((m.payload() as { code: string }).code).toBe('INTERNAL_ERROR');
  });

  it('reports a 500/unknown error to Sentry', () => {
    (Sentry.captureException as jest.Mock).mockClear();
    const m = mockHost();
    filter.catch(new Error('boom'), m.host);
    expect(m.code()).toBe(500);
    expect(Sentry.captureException as jest.Mock).toHaveBeenCalledTimes(1);
  });

  it('does NOT report a mapped 4xx (DomainError) to Sentry', () => {
    (Sentry.captureException as jest.Mock).mockClear();
    const m = mockHost();
    filter.catch(new ConflictDomainError('dup', {}), m.host);
    expect(m.code()).toBe(409);
    expect(Sentry.captureException as jest.Mock).not.toHaveBeenCalled();
  });
});
