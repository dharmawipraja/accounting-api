import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { applySoftDelete, ExtendedPrismaClient } from './soft-delete.extension';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  /** Soft-delete-extended client. Always use this for data access. */
  readonly client: ExtendedPrismaClient;
  /** We construct and own the pg pool (rather than letting PrismaPg create one)
   *  so /metrics can report live pool stats; this means we must end() it on destroy. */
  private readonly pool: Pool;

  constructor(config: ConfigService) {
    const pool = new Pool({
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
      max: config.get<number>('DB_POOL_MAX') ?? 15,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      statement_timeout: config.get<number>('DB_STATEMENT_TIMEOUT_MS') ?? 30000,
    });
    // An idle pooled client can emit 'error' out-of-band (e.g. the server
    // terminating the backend on shutdown — "terminating connection due to
    // administrator command"). Without a listener, pg re-throws it as an
    // unhandled error and crashes the process. We own the pool now, so we must
    // handle it; the broken client is already removed from the pool by pg.
    pool.on('error', () => {
      /* idle-client error — connection already evicted from the pool */
    });
    const adapter = new PrismaPg(pool);
    super({ adapter });
    this.pool = pool;
    this.client = applySoftDelete(this);
  }

  /** Live pg connection-pool stats for the /metrics db_pool_* gauges. */
  getPoolStats(): { total: number; idle: number; waiting: number } {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    await this.pool.end();
  }
}
