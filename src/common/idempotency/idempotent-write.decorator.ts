import { applyDecorators } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { Idempotent } from './idempotent.decorator';

/**
 * Composed decorator for write handlers: documents the required Idempotency-Key
 * header (OpenAPI) AND marks the handler for the global IdempotencyInterceptor.
 * Replaces the hand-paired @ApiHeader(...) + @Idempotent() block (14 sites).
 */
export function IdempotentWrite() {
  return applyDecorators(
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      description: 'Unique key to make this write safely retryable.',
    }),
    Idempotent(),
  );
}
