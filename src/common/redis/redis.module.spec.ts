import { ConfigService } from '@nestjs/config';
import { redisClientFactory } from './redis.module';

describe('redisClientFactory', () => {
  it('returns null in the test environment (no Redis dependency)', () => {
    const config = {
      get: (k: string) => (k === 'NODE_ENV' ? 'test' : undefined),
    } as unknown as ConfigService;
    expect(redisClientFactory(config)).toBeNull();
  });

  it('builds a fail-fast client when REDIS_URL is set (non-test)', () => {
    const config = {
      get: (k: string) => (k === 'NODE_ENV' ? 'development' : undefined),
      getOrThrow: (k: string) =>
        k === 'REDIS_URL' ? 'redis://localhost:6379' : undefined,
    } as unknown as ConfigService;
    const client = redisClientFactory(config);
    expect(client).not.toBeNull();
    expect(client!.options.enableOfflineQueue).toBe(false);
    expect(client!.options.maxRetriesPerRequest).toBe(1);
    // don't connect in a unit test
    client!.disconnect();
  });
});
