import { AsyncLocalStorage } from 'node:async_hooks';

/** The idempotency key a request is executing under. */
interface IdempotencyContext {
  userId: string;
  key: string;
  /** The reservation's fencing token (idempotency_keys.reservation_token).
   *  Every write to the row matches on it, so an attempt whose reservation was
   *  stale-reclaimed by a newer one can never touch the newer owner's row. */
  token: string;
}

/**
 * Request-scoped idempotency context. IdempotencyInterceptor runs the handler
 * inside `run()`; PrismaService.transaction reads it to mark the key committed
 * as the last statement of the business transaction, so the mark is durable
 * iff the write committed (and only while this attempt still owns the
 * reservation — see `token`). Absent (undefined) for non-idempotent requests.
 */
export const idempotencyContext = new AsyncLocalStorage<IdempotencyContext>();
