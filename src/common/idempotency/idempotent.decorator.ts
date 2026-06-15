import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'idempotent';

/**
 * Marks a write handler as requiring an `Idempotency-Key` header. The global
 * IdempotencyInterceptor reserves the key, runs the handler once, and replays the
 * stored response on retries. See common/idempotency/idempotency.interceptor.ts.
 */
export const Idempotent = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IDEMPOTENT_KEY, true);
