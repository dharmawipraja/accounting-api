import { ServiceUnavailableException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler';
import { UserThrottlerGuard } from './user-throttler.guard';
import { LoginIpThrottle } from './login-ip-throttle';

class Handlers {
  @LoginIpThrottle()
  login(): void {}
  refresh(): void {}
}
const handler = (name: keyof Handlers): unknown =>
  Reflect.get(Handlers.prototype, name);
const loginCtx = { getHandler: () => handler('login') };
const refreshCtx = { getHandler: () => handler('refresh') };

describe('UserThrottlerGuard.getTracker', () => {
  // getTracker doesn't touch instance state, so a prototype instance is enough.
  const guard = Object.create(
    UserThrottlerGuard.prototype,
  ) as UserThrottlerGuard & {
    getTracker(req: unknown, ctx?: unknown): Promise<string>;
  };

  it('keys by user id when authenticated', async () => {
    await expect(
      guard.getTracker({ user: { id: 'u1' }, ip: '9.9.9.9' }),
    ).resolves.toBe('user:u1');
  });

  it('keys by ip when anonymous', async () => {
    await expect(guard.getTracker({ ip: '1.2.3.4' })).resolves.toBe(
      'ip:1.2.3.4',
    );
  });

  it('keys the LOGIN handler by (normalized email, IP)', async () => {
    await expect(
      guard.getTracker(
        { ip: '1.2.3.4', body: { email: ' A@B.io ' } },
        loginCtx,
      ),
    ).resolves.toBe('login:a@b.io|1.2.3.4');
  });

  it('iter8: a decomposed and a precomposed email share ONE login bucket (NFC)', async () => {
    await expect(
      guard.getTracker(
        { ip: '1.2.3.4', body: { email: 'JOSE\u0301@b.io' } },
        loginCtx,
      ),
    ).resolves.toBe('login:jos\u00E9@b.io|1.2.3.4');
  });

  it('login without a string email falls back to ip', async () => {
    await expect(
      guard.getTracker({ ip: '1.2.3.4', body: { email: 42 } }, loginCtx),
    ).resolves.toBe('ip:1.2.3.4');
  });

  it('AUDIT3-17: ignores `email` on every non-login anonymous route', async () => {
    await expect(
      guard.getTracker(
        { ip: '1.2.3.4', body: { email: 'rotating@x.io' } },
        refreshCtx,
      ),
    ).resolves.toBe('ip:1.2.3.4');
    await expect(
      guard.getTracker({ ip: '1.2.3.4', body: { email: 'rotating@x.io' } }),
    ).resolves.toBe('ip:1.2.3.4');
  });

  it('falls back to ip:unknown when neither is present', async () => {
    await expect(guard.getTracker({})).resolves.toBe('ip:unknown');
  });
});

describe('UserThrottlerGuard.handleRequest (fail-closed)', () => {
  // Drive the override by stubbing the base ThrottlerGuard.handleRequest outcome.
  const makeGuard = (superImpl: () => Promise<boolean>) => {
    const guard = Object.create(
      UserThrottlerGuard.prototype,
    ) as UserThrottlerGuard & {
      handleRequest(r: ThrottlerRequest): Promise<boolean>;
    };
    // Stub the inherited (ThrottlerGuard) handleRequest the override delegates to.
    Object.setPrototypeOf(Object.getPrototypeOf(guard), {
      handleRequest: superImpl,
    });
    return guard;
  };

  it('passes through when under the limit', async () => {
    const guard = makeGuard(() => Promise.resolve(true));
    await expect(guard.handleRequest({} as ThrottlerRequest)).resolves.toBe(
      true,
    );
  });

  it('rethrows ThrottlerException (429) on a real limit hit', async () => {
    const guard = makeGuard(() => Promise.reject(new ThrottlerException()));
    await expect(
      guard.handleRequest({} as ThrottlerRequest),
    ).rejects.toBeInstanceOf(ThrottlerException);
  });

  it('maps a storage/Redis error to 503 (fail-closed)', async () => {
    const guard = makeGuard(() => Promise.reject(new Error('redis down')));
    await expect(
      guard.handleRequest({} as ThrottlerRequest),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
