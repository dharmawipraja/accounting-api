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

/** True when a percent-decoded PATH segment of `url` (the query string is
 *  excluded — `req.query` is checked decoded) holds U+0000 or a lone
 *  surrogate: route params are only bound after routing, so the middleware
 *  checks every segment the router could bind (e.g. `/v1/partners/%00`). A
 *  segment with malformed percent-encoding is skipped — the router answers
 *  it (400 / 404) as before; decodeURIComponent itself rejects an encoded
 *  surrogate (`%ED%A0%80`), so only `%00` can decode to a bad character. Pure. */
export function pathHasInvalidCharacters(url: string): boolean {
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  for (const segment of path.split('/')) {
    if (!segment.includes('%')) {
      if (hasInvalidCharacters(segment)) return true;
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      continue;
    }
    if (hasInvalidCharacters(decoded)) return true;
  }
  return false;
}

export const INVALID_CHARACTERS_MESSAGE =
  'Request contains an invalid character (a lone UTF-16 surrogate or U+0000)';

export interface HygieneRequest {
  body?: unknown;
  query?: unknown;
  originalUrl?: string;
  url?: string;
}

/** Where a request's invalid character is, or null when it is clean. Pure. */
export function invalidCharactersLocation(
  req: HygieneRequest,
): 'path' | 'query' | 'body' | null {
  if (pathHasInvalidCharacters(req.originalUrl ?? req.url ?? '')) return 'path';
  if (containsInvalidCharacters(req.query)) return 'query';
  if (containsInvalidCharacters(req.body)) return 'body';
  return null;
}

/** Express-style middleware, registered for every route in AppModule right
 *  AFTER jsonDepthGuard (after body parsing, before guards / interceptors /
 *  pipes — so before JwtStrategy's DB read, validation and any write): a lone
 *  surrogate or U+0000 in a body key/value, a query key/value or a path
 *  segment is a 400 INVALID_CHARACTERS `{ location }` (Audit7 P1: such input
 *  used to write the domain row while its jsonb audit row failed). The
 *  exception filter audits the rejection of a mutating request (anonymous at
 *  this stage: no guard has run). */
export function inputHygieneGuard(
  req: HygieneRequest,
  _res: unknown,
  next: (err?: unknown) => void,
): void {
  const location = invalidCharactersLocation(req);
  if (location) {
    next(new InvalidCharactersError(INVALID_CHARACTERS_MESSAGE, { location }));
    return;
  }
  next();
}
