import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { InvalidCharactersError } from '../errors/domain-errors';
import { hasInvalidCharacters } from '../text/unicode-hygiene';

/** True when any string in `value` — a string itself, an object KEY, or a
 *  string leaf of an object/array — holds a lone UTF-16 surrogate or U+0000
 *  (see `hasInvalidCharacters`). ITERATIVE (explicit stack), like
 *  `exceedsDepth`: request bodies reach it already capped at MAX_BODY_DEPTH
 *  (jsonDepthGuard runs first) and at the 1 MB parser limit, and the qs query
 *  parser caps its own depth, so the walk is bounded by input size and can
 *  never overflow the call stack. Stops at the first hit. Pure. */
export function containsInvalidCharacters(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node === 'string') {
      if (hasInvalidCharacters(node)) return true;
      continue;
    }
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const child of node as unknown[]) stack.push(child);
      continue;
    }
    for (const [k, child] of Object.entries(node as Record<string, unknown>)) {
      if (hasInvalidCharacters(k)) return true;
      stack.push(child);
    }
  }
  return false;
}

export const INVALID_CHARACTERS_MESSAGE =
  'Request contains an invalid character (a lone UTF-16 surrogate or U+0000)';

export interface HygieneRequest {
  body?: unknown;
  query?: unknown;
  /** Route params, bound (and percent-decoded) by the router — so a guard
   *  sees `/v1/partners/%00` as `{ id: '\u0000' }`. */
  params?: unknown;
}

/** Where a request's invalid character is, or null when it is clean: a
 *  route param (`'path'` — the public `details.location` value), then the
 *  query, then the body. Pure. */
export function invalidCharactersLocation(
  req: HygieneRequest,
): 'path' | 'query' | 'body' | null {
  if (containsInvalidCharacters(req.params)) return 'path';
  if (containsInvalidCharacters(req.query)) return 'query';
  if (containsInvalidCharacters(req.body)) return 'body';
  return null;
}

/** Global guard (APP_GUARD, ordered in AppModule JwtAuthGuard →
 *  UserThrottlerGuard → InputHygieneGuard → RolesGuard → PasswordChangeGuard):
 *  a lone surrogate or U+0000 in a body key/value, a query key/value or a
 *  route param is a 400 INVALID_CHARACTERS `{ location }` before validation,
 *  the role check and any handler write (such input used to write
 *  the domain row while its jsonb audit row failed). Running AFTER
 *  authentication and the throttle means the exception filter's rejection
 *  row follows the normal rules: an authenticated caller's row carries its
 *  user and the (8 KiB-capped, storable) body; an anonymous one on a public
 *  route stores `{}` — or the repaired `{ email }` of a login attempt. So an
 *  unauthenticated bad-character request is a 401 first, and an unknown
 *  route (no guard runs) stays a 404. The body walk relies on jsonDepthGuard
 *  (middleware) having capped the depth first. */
@Injectable()
export class InputHygieneGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const location = invalidCharactersLocation(
      context.switchToHttp().getRequest<HygieneRequest>(),
    );
    if (location) {
      throw new InvalidCharactersError(INVALID_CHARACTERS_MESSAGE, {
        location,
      });
    }
    return true;
  }
}
