import { CallHandler, ExecutionContext, HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { firstValueFrom, of, throwError } from 'rxjs';
import { AuditInterceptor, entityIdOf } from './audit.interceptor';
import { AuditService } from './audit.service';
import {
  ConflictDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';

function makeCtx(method = 'POST'): ExecutionContext {
  const req = {
    method,
    originalUrl: '/v1/sales-invoices',
    url: '/v1/sales-invoices',
    params: {},
    body: {},
    ip: '1.2.3.4',
    user: { id: 'u1', role: 'ADMIN' },
  };
  const res = { statusCode: 201 };
  return {
    getHandler: () => undefined,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

const handlerThatThrows = (err: unknown): CallHandler => ({
  handle: () => throwError(() => err),
});

describe('AuditInterceptor', () => {
  const setup = () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const interceptor = new AuditInterceptor({
      record,
    } as unknown as AuditService);
    return { record, interceptor };
  };

  it('records a DomainError with its real status (422), not 500', async () => {
    const { record, interceptor } = setup();
    const obs = interceptor.intercept(
      makeCtx(),
      handlerThatThrows(new ValidationFailedError('Idempotency-Key required')),
    );
    await expect(firstValueFrom(obs)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 422 }),
    );
  });

  it('records a ConflictDomainError as 409', async () => {
    const { record, interceptor } = setup();
    const obs = interceptor.intercept(
      makeCtx(),
      handlerThatThrows(new ConflictDomainError('in flight')),
    );
    await expect(firstValueFrom(obs)).rejects.toBeInstanceOf(
      ConflictDomainError,
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 409 }),
    );
  });

  it('records an HttpException with its status', async () => {
    const { record, interceptor } = setup();
    const obs = interceptor.intercept(
      makeCtx(),
      handlerThatThrows(new HttpException('forbidden', 403)),
    );
    await expect(firstValueFrom(obs)).rejects.toBeInstanceOf(HttpException);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 403 }),
    );
  });

  it('records a Prisma P2025 as 404 (the status the filter returns), not 500', async () => {
    const { record, interceptor } = setup();
    const err = new Prisma.PrismaClientKnownRequestError('not found', {
      code: 'P2025',
      clientVersion: Prisma.prismaVersion.client,
    });
    const obs = interceptor.intercept(makeCtx(), handlerThatThrows(err));
    await expect(firstValueFrom(obs)).rejects.toBe(err);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 404 }),
    );
  });

  it('records an unknown error as 500', async () => {
    const { record, interceptor } = setup();
    const obs = interceptor.intercept(
      makeCtx(),
      handlerThatThrows(new Error('boom')),
    );
    await expect(firstValueFrom(obs)).rejects.toBeInstanceOf(Error);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500 }),
    );
  });

  it('records the response status on success and passes data through', async () => {
    const { record, interceptor } = setup();
    const next = { handle: () => of({ ok: true }) } as unknown as CallHandler;
    const result = await firstValueFrom(interceptor.intercept(makeCtx(), next));
    expect(result).toEqual({ ok: true });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 201 }),
    );
  });

  it('skips auditing for non-mutating methods', async () => {
    const { record, interceptor } = setup();
    const next = { handle: () => of({ ok: true }) } as unknown as CallHandler;
    const result = await firstValueFrom(
      interceptor.intercept(makeCtx('GET'), next),
    );
    expect(result).toEqual({ ok: true });
    expect(record).not.toHaveBeenCalled();
  });

  it('records the request id and the response entity id on success', async () => {
    const { record, interceptor } = setup();
    const ctx = makeCtx();
    ctx.switchToHttp().getRequest<{ id?: string }>().id = 'trace-1';
    const obs = interceptor.intercept(ctx, {
      handle: () => of({ id: 'e-1', name: 'x' }),
    });
    await firstValueFrom(obs);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'trace-1', entityId: 'e-1' }),
    );
  });
});

describe('entityIdOf', () => {
  it('extracts a string id and ignores everything else', () => {
    expect(entityIdOf({ id: 'abc' })).toBe('abc');
    expect(entityIdOf({ id: 42 })).toBeNull();
    expect(entityIdOf({ id: '' })).toBeNull();
    expect(entityIdOf({ id: 'x'.repeat(129) })).toBeNull();
    expect(entityIdOf(undefined)).toBeNull();
    expect(entityIdOf([{ id: 'a' }])).toBeNull();
    expect(entityIdOf('id')).toBeNull();
  });

  it('uses user.id for a { user, tempPassword } response (user create / reset-password)', () => {
    expect(entityIdOf({ user: { id: 'u-1' }, tempPassword: 'x' })).toBe('u-1');
    expect(entityIdOf({ user: { id: 42 } })).toBeNull();
    expect(entityIdOf({ user: null })).toBeNull();
  });
});
