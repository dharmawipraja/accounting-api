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
