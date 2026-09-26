import { SetMetadata } from '@nestjs/common';

/** Handler metadata key set by `@ReadOnlyPost()`. */
export const READ_ONLY_POST_KEY = 'audit:read-only-post';

/**
 * Marks a POST handler that changes no state (a pure preview/calculation, e.g.
 * `POST /tax/calculate`, `POST /journal-entries/preview`). AuditInterceptor
 * still writes its row, but always at the small (8 KiB) body tier: the
 * 512 KiB tier exists so an ACCEPTED WRITE is never truncated in the
 * append-only log, and a read-only request records nothing worth that space —
 * without this any role could store ~512 KiB per request (iteration-5).
 * Keyed on the handler (read with Reflector), never on the path.
 */
export const ReadOnlyPost = (): MethodDecorator =>
  SetMetadata(READ_ONLY_POST_KEY, true);
