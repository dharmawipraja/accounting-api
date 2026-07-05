import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

const logger = new Logger('Redis');

/** Builds the shared client: null in tests (in-memory throttler), else a fail-fast
 *  ioredis client (so a Redis outage rejects promptly instead of hanging). */
export function redisClientFactory(config: ConfigService): Redis | null {
  if (config.get<string>('NODE_ENV') === 'test') return null;
  const client = new Redis(config.getOrThrow<string>('REDIS_URL'), {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 1000,
  });
  // Own the connection: an out-of-band error must be logged, not crash the process.
  client.on('error', (err) =>
    logger.warn(`redis client error: ${err.message}`),
  );
  return client;
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: redisClientFactory,
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis | null) {}

  // onApplicationShutdown (NOT onModuleDestroy): runs after the HTTP server
  // has drained, so throttler lookups for in-flight requests still succeed.
  async onApplicationShutdown(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }
}
