import { AsyncLocalStorage } from 'node:async_hooks';

/** The idempotency key a request is executing under. */
export interface IdempotencyContext {
  userId: string;
  key: string;
}

/**
 * Request-scoped idempotency context. IdempotencyInterceptor runs the handler
 * inside `run()`; PrismaService.transaction reads it to mark the key committed
 * as the last statement of the business transaction, so the mark is durable
 * iff the write committed. Absent (undefined) for non-idempotent requests.
 */
export const idempotencyContext = new AsyncLocalStorage<IdempotencyContext>();
