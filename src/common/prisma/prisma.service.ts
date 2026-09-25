import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { idempotencyContext } from '../idempotency/idempotency-context';
import { applySoftDelete, ExtendedPrismaClient } from './soft-delete.extension';

/** The interactive-transaction view of the soft-delete-extended client — what a
 *  `transaction(async (tx) => …)` callback receives. Shared so services can
 *  compose writes (e.g. journal posting) into one transaction. */
export type LedgerTx = Omit<
  ExtendedPrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends' | '$use'
>;

export interface TransactionOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnApplicationShutdown
{
  /** Soft-delete-extended client. Always use this for data access. */
  readonly client: ExtendedPrismaClient;
  /** We construct and own the pg pool (rather than letting PrismaPg create one)
   *  so /metrics can report live pool stats; this means we must end() it on destroy. */
  private readonly pool: Pool;
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    const pool = new Pool({
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
      max: config.get<number>('DB_POOL_MAX') ?? 15,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      statement_timeout: config.get<number>('DB_STATEMENT_TIMEOUT_MS') ?? 30000,
    });
    const adapter = new PrismaPg(pool);
    super({ adapter });
    this.pool = pool;
    // An idle pooled client can emit 'error' out-of-band (e.g. the server
    // terminating the backend on shutdown — "terminating connection due to
    // administrator command"). Without a listener, pg re-throws it as an
    // unhandled error and crashes the process. We own the pool now, so we must
    // handle it (the broken client is already removed from the pool by pg); log
    // rather than rethrow — a recurring one signals DB instability worth seeing.
    // (Registered after super() so `this` is initialized.)
    this.pool.on('error', (err) => {
      this.logger.warn(`idle pool client error: ${err.message}`);
    });
    this.client = applySoftDelete(this);
  }

  /**
   * The ONLY way to open an interactive transaction in src/ (ESLint forbids a
   * raw `$transaction(` elsewhere). Identical to `client.$transaction(fn, opts)`
   * except that, when the request runs under an Idempotency-Key, the key row is
   * marked `committed_at = now()` as the LAST statement of the transaction —
   * so the mark is durable iff the business write committed. The interceptor
   * then never releases (and reserve() never reclaims) a committed key, so a
   * same-key retry after a lost response gets 409 instead of re-executing the
   * write. A rolled-back attempt (e.g. a restart loop) discards its mark.
   */
  async transaction<T>(
    fn: (tx: LedgerTx) => Promise<T>,
    opts?: TransactionOptions,
  ): Promise<T> {
    return this.client.$transaction(async (tx) => {
      const result = await fn(tx);
      const ctx = idempotencyContext.getStore();
      if (ctx) {
        await tx.$executeRaw`
          UPDATE idempotency_keys SET committed_at = now()
          WHERE user_id = ${ctx.userId} AND "key" = ${ctx.key}`;
      }
      return result;
    }, opts);
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

  // onApplicationShutdown (NOT onModuleDestroy): Nest closes the HTTP server
  // between the two, so this is the only hook where in-flight requests have
  // already drained and it's safe to take the DB away.
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
    await this.pool.end();
  }
}
