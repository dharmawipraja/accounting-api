import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
} from '@nestjs/common';
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
});
