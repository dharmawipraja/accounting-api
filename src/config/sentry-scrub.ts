/** Minimal structural view of the parts of a Sentry event we scrub. */
export interface ScrubbableEvent {
  request?: {
    data?: unknown;
    query_string?: unknown;
    headers?: Record<string, unknown>;
  };
}

/** Conservative PII scrub for Sentry `beforeSend`: drop request bodies and query
 *  strings (may carry tokens), and remove the authorization/cookie headers. Stack
 *  traces, breadcrumbs, and non-sensitive headers are retained. */
export function scrubSentryEvent<T extends ScrubbableEvent>(event: T): T {
  if (!event.request) return event;
  delete event.request.data;
  delete event.request.query_string;
  if (event.request.headers) {
    delete event.request.headers.authorization;
    delete event.request.headers.cookie;
  }
  return event;
}
