/** Requests answered with a STORED response by the IdempotencyInterceptor
 *  (same user + Idempotency-Key + request: no handler ran, no new write).
 *  Set by the idempotency interceptor, read by the (outer) AuditInterceptor
 *  so the audit row carries `replayed = true` and can't be mistaken for a
 *  second creation. A WeakSet: nothing leaks onto the request object. */
const replayed = new WeakSet<object>();

export function markIdempotentReplay(req: object): void {
  replayed.add(req);
}

export function isIdempotentReplay(req: object): boolean {
  return replayed.has(req);
}
