/** Shape a caller-supplied X-Request-Id must have to be kept (for correlation
 *  only — the trace id itself is always server-generated). */
const SAFE_CLIENT_REQUEST_ID = /^[\w.-]{1,128}$/;

/** The inbound X-Request-Id if it is a single safe-shaped value, else null. */
export function clientRequestIdOf(header: unknown): string | null {
  return typeof header === 'string' && SAFE_CLIENT_REQUEST_ID.test(header)
    ? header
    : null;
}
