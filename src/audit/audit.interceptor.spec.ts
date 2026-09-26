import {
  Body,
  CallHandler,
  ExecutionContext,
  HttpException,
  Param,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { firstValueFrom, of, throwError } from 'rxjs';
import {
  AuditInterceptor,
  entityIdOf,
  handlerBindsBody,
} from './audit.interceptor';
import { IsString } from 'class-validator';
import { RejectionAuditLimiter } from './rejection-audit-limiter';
import { globalValidationPipe } from './validated-body';
import { ReadOnlyPost } from './read-only-post';
import { TokenGrant } from './token-grant';
import { LoginIpThrottle } from '../common/guards/login-ip-throttle';
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
      new Reflector(),
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
  @ReadOnlyPost()
  readOnly(@Body() _dto: unknown): void {}
  @LoginIpThrottle()
  login(@Body() _dto: unknown): void {}
  @TokenGrant()
  refresh(@Body() _dto: unknown): void {}
  logout(@Body() _dto: unknown): void {}
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
      new Reflector(),
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

describe('AuditInterceptor iteration-5 ruling', () => {
  const setup = (limiter = new RejectionAuditLimiter()) => {
    const record = jest.fn().mockResolvedValue(undefined);
    const interceptor = new AuditInterceptor(
      { record } as unknown as AuditService,
      limiter,
      new Reflector(),
    );
    return { record, interceptor };
  };
  const viewer = { id: 'u1', role: 'VIEWER' };
  const bodyReq = (body: unknown, user?: { id: string; role: string }) => ({
    method: 'POST',
    url: '/v1/x',
    params: {},
    body,
    ip: '1.2.3.4',
    user,
  });

  it('a @ReadOnlyPost() handler 2xx stores <= 8 KiB of a 300 KB body', async () => {
    const { record, interceptor } = setup();
    const req = bodyReq({ note: 'n'.repeat(300 * 1024) }, viewer);
    await firstValueFrom(
      interceptor.intercept(routedCtx('readOnly', req, 200), {
        handle: () => of({ lines: [] }),
      }),
    );
    const [[row]] = record.mock.calls as [[{ body: unknown }]];
    expect(row.body).toMatchObject({ _truncated: true });
    expect(Buffer.byteLength(JSON.stringify(row.body))).toBeLessThanOrEqual(
      8192,
    );
    // …while an unmarked body-binding handler keeps the 512 KiB tier.
    await firstValueFrom(
      interceptor.intercept(routedCtx('withBody', req), {
        handle: () => of({ id: 'e1' }),
      }),
    );
    expect(record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ body: req.body }),
    );
  });

  it('anonymous 2xx rows count against the anonymous global ceiling', async () => {
    const limiter = new RejectionAuditLimiter({ globalLimit: 2 });
    const { record, interceptor } = setup(limiter);
    const ok = () =>
      firstValueFrom(
        interceptor.intercept(routedCtx('withBody', bodyReq({})), {
          handle: () => of({ ok: true }),
        }),
      );
    await expect(ok()).resolves.toEqual({ ok: true });
    await expect(ok()).resolves.toEqual({ ok: true });
    // Over the ceiling: the response still passes through, no row.
    await expect(ok()).resolves.toEqual({ ok: true });
    expect(record).toHaveBeenCalledTimes(2);
    expect(limiter.allowAnonymousGlobal()).toBe(false);
    // Authenticated 2xx rows are never subject to it.
    await firstValueFrom(
      interceptor.intercept(routedCtx('withBody', bodyReq({}, viewer)), {
        handle: () => of({ id: 'e1' }),
      }),
    );
    expect(record).toHaveBeenCalledTimes(3);
  });
});

describe('AuditInterceptor anonymous ceiling scope (final wave I1)', () => {
  const exhausted = () => {
    const limiter = new RejectionAuditLimiter({ globalLimit: 1 });
    expect(limiter.allowAnonymousGlobal()).toBe(true);
    expect(limiter.allowAnonymousGlobal()).toBe(false);
    const record = jest.fn().mockResolvedValue(undefined);
    const interceptor = new AuditInterceptor(
      { record } as unknown as AuditService,
      limiter,
      new Reflector(),
    );
    return { record, interceptor };
  };
  const anonReq = () => ({
    method: 'POST',
    url: '/v1/auth/x',
    params: {},
    body: { email: 'a@b.c' },
    ip: '1.2.3.4',
  });
  const run = (
    interceptor: AuditInterceptor,
    method: 'login' | 'refresh' | 'logout',
    status = 200,
  ) =>
    firstValueFrom(
      interceptor.intercept(routedCtx(method, anonReq(), status), {
        handle: () => of({ ok: true }),
      }),
    );

  it('ceiling exhausted: a successful login 2xx is still audited', async () => {
    const { record, interceptor } = exhausted();
    await expect(run(interceptor, 'login')).resolves.toEqual({ ok: true });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 200 }),
    );
  });

  it('ceiling exhausted: a successful refresh 2xx (@TokenGrant) is still audited (per-user bucket)', async () => {
    const { record, interceptor } = exhausted();
    const pair = { accessToken: jwtWithSub('u-1'), refreshToken: 'r' };
    await expect(
      firstValueFrom(
        interceptor.intercept(routedCtx('refresh', anonReq(), 200), {
          handle: () => of(pair),
        }),
      ),
    ).resolves.toEqual(pair);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('ceiling exhausted: a logout 2xx is suppressed (response still sent)', async () => {
    const { record, interceptor } = exhausted();
    await expect(run(interceptor, 'logout')).resolves.toEqual({ ok: true });
    expect(record).not.toHaveBeenCalled();
  });

  it('ceiling exhausted: a failed login 4xx is still suppressed', async () => {
    const { record, interceptor } = exhausted();
    await expect(
      firstValueFrom(
        interceptor.intercept(routedCtx('login', anonReq(), 200), {
          handle: () => throwError(() => new UnauthorizedException()),
        }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(record).not.toHaveBeenCalled();
  });
});

class NoteDto {
  @IsString() note!: string;
}

const jwtWithSub = (sub: unknown) =>
  [
    Buffer.from('{"alg":"HS256"}').toString('base64url'),
    Buffer.from(JSON.stringify({ sub, typ: 'access' })).toString('base64url'),
    'sig',
  ].join('.');

describe('AuditInterceptor iteration-6', () => {
  const setup = (limiter = new RejectionAuditLimiter()) => {
    const record = jest.fn().mockResolvedValue(undefined);
    const interceptor = new AuditInterceptor(
      { record } as unknown as AuditService,
      limiter,
      new Reflector(),
    );
    return { record, interceptor };
  };
  const anonReq = () => ({
    method: 'POST',
    url: '/v1/auth/refresh',
    params: {},
    body: { refreshToken: 'x' },
    ip: '1.2.3.4',
  });
  const refresh = (interceptor: AuditInterceptor, sub: unknown) =>
    firstValueFrom(
      interceptor.intercept(routedCtx('refresh', anonReq(), 200), {
        handle: () => of({ accessToken: jwtWithSub(sub), refreshToken: 'r' }),
      }),
    );

  it('refresh 2xx rows: 60/min per token owner, then the anonymous global ceiling', async () => {
    const limiter = new RejectionAuditLimiter({ globalLimit: 1 });
    const { record, interceptor } = setup(limiter);
    for (let i = 0; i < 60; i++) await refresh(interceptor, 'u-1');
    expect(record).toHaveBeenCalledTimes(60);
    await refresh(interceptor, 'u-1'); // 61st: global ceiling (1 left)
    await refresh(interceptor, 'u-1'); // 62nd: ceiling exhausted → dropped
    expect(record).toHaveBeenCalledTimes(61);
    await refresh(interceptor, 'u-2'); // another owner has its own bucket
    expect(record).toHaveBeenCalledTimes(62);
  });

  it('a refresh 2xx whose response carries no decodable subject uses the global ceiling', async () => {
    const limiter = new RejectionAuditLimiter({ globalLimit: 0 });
    const { record, interceptor } = setup(limiter);
    await refresh(interceptor, 42);
    await firstValueFrom(
      interceptor.intercept(routedCtx('refresh', anonReq(), 200), {
        handle: () => of({ accessToken: 'not-a-jwt' }),
      }),
    );
    expect(record).not.toHaveBeenCalled();
  });

  it('anonymous 5xx rows count against the anonymous global ceiling', async () => {
    const limiter = new RejectionAuditLimiter({ globalLimit: 1 });
    const { record, interceptor } = setup(limiter);
    const boom = () =>
      expect(
        firstValueFrom(
          interceptor.intercept(
            routedCtx('logout', anonReq(), 200),
            handlerThatThrows(new Error('boom')),
          ),
        ),
      ).rejects.toThrow('boom');
    await boom();
    await boom(); // over the ceiling: still propagates, no row
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 500 }),
    );
  });

  describe('validated-body tier', () => {
    const viewer = { id: 'u1', role: 'VIEWER' };
    const bigBody = () => ({ note: 'n'.repeat(300 * 1024) });
    const authReq = (body: unknown) => ({
      method: 'POST',
      url: '/v1/x',
      params: {},
      body,
      ip: '1.2.3.4',
      user: viewer,
    });
    const fail = async (
      method: keyof RouteFixture,
      req: Record<string, unknown>,
      err: unknown,
    ) => {
      const { record, interceptor } = setup();
      await firstValueFrom(
        interceptor.intercept(routedCtx(method, req), handlerThatThrows(err)),
      ).catch(() => undefined);
      const [[row]] = record.mock.calls as [[{ body: unknown }]];
      return row.body;
    };
    const markValidated = async (body: object) => {
      await globalValidationPipe().transform(body, {
        type: 'body',
        metatype: NoteDto,
      });
    };

    it('a 408 / 500 after the pipe accepted the body keeps the full (512 KiB tier) body', async () => {
      for (const err of [
        new HttpException('timeout', 408),
        new Error('boom'),
      ]) {
        const body = bigBody();
        await markValidated(body);
        expect(await fail('withBody', authReq(body), err)).toEqual(body);
      }
    });

    it('an unvalidated body (pipe rejected / never ran) stays <= 8 KiB on a 408 / 500', async () => {
      for (const err of [
        new HttpException('timeout', 408),
        new Error('boom'),
      ]) {
        expect(await fail('withBody', authReq(bigBody()), err)).toMatchObject({
          _truncated: true,
        });
      }
    });

    it('a validated body stays small on other 4xx, read-only POSTs, and anonymous 5xx; {} when bodyless', async () => {
      const cases: Array<[keyof RouteFixture, boolean, unknown]> = [
        ['withBody', true, new HttpException('bad', 422)],
        ['readOnly', true, new Error('boom')],
        ['withBody', false, new Error('boom')],
      ];
      for (const [method, authed, err] of cases) {
        const body = bigBody();
        await markValidated(body);
        const req = authed
          ? authReq(body)
          : { ...authReq(body), user: undefined };
        expect(await fail(method, req, err)).toMatchObject({
          _truncated: true,
        });
      }
      const body = bigBody();
      await markValidated(body);
      expect(await fail('bodyless', authReq(body), new Error('x'))).toEqual({});
    });
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
