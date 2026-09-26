import { BadRequestException } from '@nestjs/common';

/** Deepest container nesting a request body may have (top-level object/array
 *  = depth 1). Real payloads (document → lines → fields) are < 5 deep. */
export const MAX_BODY_DEPTH = 32;

/** True when `value` nests objects/arrays deeper than `max`. ITERATIVE (explicit
 *  stack), so a 20k-deep body cannot overflow the call stack while being
 *  checked; stops at the first container past the limit. Pure. */
export function exceedsDepth(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (node === null || typeof node !== 'object') continue;
    if (depth > max) return true;
    const children = Array.isArray(node)
      ? (node as unknown[])
      : Object.values(node as Record<string, unknown>);
    for (const child of children) {
      if (child !== null && typeof child === 'object') {
        stack.push([child, depth + 1]);
      }
    }
  }
  return false;
}

/** Express-style middleware (registered for every route in AppModule, so it
 *  runs after body parsing and before guards/interceptors/pipes): a body nested
 *  deeper than MAX_BODY_DEPTH is a 400, before the recursive audit sanitizer or
 *  class-validator/-transformer can blow the stack (→ 500 + Sentry). */
export function jsonDepthGuard(
  req: { body?: unknown },
  _res: unknown,
  next: (err?: unknown) => void,
): void {
  if (exceedsDepth(req.body, MAX_BODY_DEPTH)) {
    next(
      new BadRequestException(
        `Request body is nested deeper than ${MAX_BODY_DEPTH} levels`,
      ),
    );
    return;
  }
  next();
}
