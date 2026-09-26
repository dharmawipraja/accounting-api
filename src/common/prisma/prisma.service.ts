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
import { ConflictDomainError } from '../errors/domain-errors';
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
  /** Issue `SET TRANSACTION READ ONLY` as the callback's first statement (it
   *  runs right after the adapter's BEGIN / SET TRANSACTION ISOLATION LEVEL,
   *  before any query takes the snapshot). A read-only transaction writes
   *  nothing, so it never marks an idempotency key (the mark is an UPDATE). */
  readOnly?: boolean;
}

/**
 * Options for a report's snapshot read: every query of a multi-query report
 * sees ONE consistent snapshot (REPEATABLE READ), so a post committing
 * mid-request can't make it internally inconsistent. READ ONLY: takes only
 * ACCESS SHARE locks, never blocks posting, and a read-only RR transaction can
 * never hit a serialization failure.
 *
 * Budget is ADDITIVE: maxWait (waiting for a pooled connection) + timeout
 * (the transaction itself) must stay < REQUEST_TIMEOUT_MS (35s) so a slow
 * report fails as a clean retryable 409 (P2028) before the interceptor's 408 —
 * preserving the escalation order DB 30s → 408 35s → socket 40s (main.ts).
 * 5s + 25s = 30s (asserted in tx-timeout-budget.spec.ts).
 */
export const REPORT_SNAPSHOT_TX: TransactionOptions = {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  readOnly: true,
  maxWait: 5_000,
  timeout: 25_000,
};

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
   * marked `committed_at` (UTC) as the LAST statement of the transaction — so
   * the mark is durable iff the business write committed. The interceptor then
   * never releases (and reserve() never reclaims) a committed key, so a
   * same-key retry after a lost response gets 409 instead of re-executing the
   * write. A rolled-back attempt (e.g. a restart loop) discards its mark.
   *
   * The mark is fenced by the reservation token: if this attempt's reservation
   * was stale-reclaimed by a newer attempt (token rotated), it matches 0 rows
   * and the transaction is rolled back with a 409 — the newer owner executes
   * the request, this one never double-writes it.
   */
  async transaction<T>(
    fn: (tx: LedgerTx) => Promise<T>,
    opts?: TransactionOptions,
  ): Promise<T> {
    // Captured synchronously, before $transaction: the callback may run in an
    // async context Prisma/the driver created, where getStore() could differ.
    const { readOnly, ...txOpts } = opts ?? {};
    const ctx = readOnly ? undefined : idempotencyContext.getStore();
    return this.client.$transaction(async (tx) => {
      if (readOnly) await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const result = await fn(tx);
      if (ctx) {
        const marked = await tx.$executeRaw`
          UPDATE idempotency_keys SET committed_at = now() AT TIME ZONE 'UTC'
          WHERE user_id = ${ctx.userId} AND "key" = ${ctx.key}
            AND reservation_token = ${ctx.token}::uuid`;
        if (marked === 0) {
          throw new ConflictDomainError(
            'The idempotency reservation for this request was taken over by a newer attempt with the same key; this attempt was rolled back',
            { key: ctx.key, reclaimed: true },
          );
        }
      }
      return result;
    }, txOpts);
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
