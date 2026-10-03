import { ServiceUnavailableException } from '@nestjs/common';
import type Redis from 'ioredis';
import { LoginFailureLimiter } from './login-failure-limiter';
import { MetricsService } from '../metrics/metrics.service';
import { LOGIN_FAILURE } from '../config/throttle.config';

const metrics = {
  incLoginFailure: jest.fn(),
  incLoginLockout: jest.fn(),
} as unknown as MetricsService;

/** Records the MULTI pipeline so we can assert INCR + PEXPIRE NX go together. */
function fakeRedis(exec: () => Promise<unknown>) {
  const calls: unknown[][] = [];
  const chain = {
    incr: (...a: unknown[]) => (calls.push(['incr', ...a]), chain),
    pexpire: (...a: unknown[]) => (calls.push(['pexpire', ...a]), chain),
    exec,
  };
  return { redis: { multi: () => chain } as unknown as Redis, calls };
}

describe('LoginFailureLimiter counter', () => {
  it('increments and sets the TTL in ONE multi with PEXPIRE NX', async () => {
    const { redis, calls } = fakeRedis(() =>
      Promise.resolve([
        [null, 3],
        [null, 0],
      ]),
    );
    await new LoginFailureLimiter(redis, metrics).recordFailure('A@x.io');
    expect(calls).toEqual([
      ['incr', 'lf:a@x.io'],
      ['pexpire', 'lf:a@x.io', LOGIN_FAILURE.windowMs, 'NX'],
    ]);
  });

  it.each([
    ['a rejected exec', () => Promise.reject(new Error('down'))],
    ['a per-command error', () => Promise.resolve([[new Error('x'), null]])],
    ['a null (aborted) exec', () => Promise.resolve(null)],
  ])('fails closed (503) on %s', async (_, exec) => {
    const { redis } = fakeRedis(exec);
    await expect(
      new LoginFailureLimiter(redis, metrics).recordFailure('a@x.io'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('in-memory: past the hard ceiling even a known IP is refused', async () => {
    const lim = new LoginFailureLimiter(null, metrics);
    await lim.recordSuccess('o@x.io', '10.0.0.1');
    for (let i = 0; i < LOGIN_FAILURE.hardLimit - 1; i++)
      await lim.recordFailure('o@x.io');
    await expect(lim.assertAllowed('o@x.io', '10.0.0.1')).resolves.toBe(
      undefined,
    );
    await expect(lim.assertAllowed('o@x.io', '10.0.0.2')).rejects.toThrow(
      /Too many/,
    );
    await lim.recordFailure('o@x.io');
    await expect(lim.assertAllowed('o@x.io', '10.0.0.1')).rejects.toThrow(
      /Too many/,
    );
  });
});
