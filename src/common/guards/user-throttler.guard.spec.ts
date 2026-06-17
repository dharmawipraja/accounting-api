import { ServiceUnavailableException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler';
import { UserThrottlerGuard } from './user-throttler.guard';

describe('UserThrottlerGuard.getTracker', () => {
  // getTracker doesn't touch instance state, so a prototype instance is enough.
  const guard = Object.create(
    UserThrottlerGuard.prototype,
  ) as UserThrottlerGuard & {
    getTracker(req: unknown): Promise<string>;
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
