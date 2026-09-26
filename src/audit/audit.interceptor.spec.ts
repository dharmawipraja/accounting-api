import {
  Body,
  CallHandler,
  ExecutionContext,
  HttpException,
  Param,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { firstValueFrom, of, throwError } from 'rxjs';
import {
  AuditInterceptor,
  entityIdOf,
  handlerBindsBody,
} from './audit.interceptor';
import { RejectionAuditLimiter } from './rejection-audit-limiter';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
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
    const interceptor = new AuditInterceptor(
      { record } as unknown as AuditService,
      new RejectionAuditLimiter(),
    );
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

class RouteFixture {
  withBody(@Param('id') _id: string, @Body() _dto: unknown): void {}
  bodyless(@CurrentUser() _user: unknown, @Param('id') _id: string): void {}
}

/** A routed context for a RouteFixture method (looked up by name, as Nest's
 *  router does). */
function routedCtx(
  method: keyof RouteFixture,
  req: Record<string, unknown>,
  statusCode = 201,
): ExecutionContext {
  const handler = (
    RouteFixture.prototype as unknown as Record<string, unknown>
  )[method];
  return {
    getHandler: () => handler,
    getClass: () => RouteFixture,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({ statusCode }),
    }),
  } as unknown as ExecutionContext;
}

describe('AuditInterceptor body cap (iteration-4 ruling)', () => {
  const setup = (limiter = new RejectionAuditLimiter()) => {
    const record = jest.fn().mockResolvedValue(undefined);
    const interceptor = new AuditInterceptor(
      { record } as unknown as AuditService,
      limiter,
    );
    return { record, interceptor };
  };
  const bigReq = (user?: { id: string; role: string }) => ({
    method: 'POST',
    url: '/v1/x',
    params: {},
    body: { junk: 'q'.repeat(500 * 1024) },
    ip: '1.2.3.4',
    user,
  });
  const viewer = { id: 'u1', role: 'VIEWER' };

  it('handlerBindsBody reads @Body() from Nest route-arg metadata', () => {
    expect(handlerBindsBody(routedCtx('withBody', {}))).toBe(true);
    expect(handlerBindsBody(routedCtx('bodyless', {}))).toBe(false);
    // Unknown handler (no getClass) → conservative true.
    expect(handlerBindsBody(makeCtx())).toBe(true);
  });

  it('a bodyless handler 2xx stores {} even for a 500 KB body', async () => {
    const { record, interceptor } = setup();
    await firstValueFrom(
      interceptor.intercept(routedCtx('bodyless', bigReq(viewer)), {
        handle: () => of({ ok: true }),
      }),
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 201, body: {} }),
    );
  });

  it('an authenticated 4xx on a body-binding handler stores <= 8 KiB', async () => {
    const { record, interceptor } = setup();
    await expect(
      firstValueFrom(
        interceptor.intercept(
          routedCtx('withBody', bigReq(viewer)),
          handlerThatThrows(new HttpException('bad', 400)),
        ),
      ),
    ).rejects.toBeInstanceOf(HttpException);
    const [[row]] = record.mock.calls as [[{ body: unknown }]];
    expect(row.body).toMatchObject({ _truncated: true });
    expect(Buffer.byteLength(JSON.stringify(row.body))).toBeLessThanOrEqual(
      8192,
    );
  });

  it('an authenticated 2xx on a body-binding handler keeps a 300 KB body', async () => {
    const { record, interceptor } = setup();
    const req = { ...bigReq(viewer), body: { note: 'n'.repeat(300 * 1024) } };
    await firstValueFrom(
      interceptor.intercept(routedCtx('withBody', req), {
        handle: () => of({ id: 'e1' }),
      }),
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ body: req.body }),
    );
  });

  it('anonymous 4xx rows count against the anonymous global ceiling', async () => {
    const limiter = new RejectionAuditLimiter({ globalLimit: 2 });
    const { record, interceptor } = setup(limiter);
    const fail = () =>
      expect(
        firstValueFrom(
          interceptor.intercept(
            routedCtx('withBody', bigReq()),
            handlerThatThrows(new UnauthorizedException()),
          ),
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    await fail();
    await fail();
    await fail(); // over the ceiling: the error still propagates, no row
    expect(record).toHaveBeenCalledTimes(2);
    // …and the shared budget is spent for guard rejections too.
    expect(limiter.allow('9.9.9.9')).toBe(false);
    // Authenticated rows are never subject to it.
    await expect(
      firstValueFrom(
        interceptor.intercept(
          routedCtx('withBody', bigReq(viewer)),
          handlerThatThrows(new HttpException('bad', 400)),
        ),
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(record).toHaveBeenCalledTimes(3);
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
