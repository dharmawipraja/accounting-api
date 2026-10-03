/** Parse the CORS_ORIGIN env (comma-separated) into an origin list, or `false`
 *  to disable CORS. Trims each entry and drops empties; an all-empty value is
 *  treated as disabled (fail-closed) rather than an array of empty strings. */
export function parseCorsOrigins(raw: string | undefined): string[] | false {
  if (!raw) return false;
  const origins = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : false;
}

/** The app's CORS options. Non-safelisted response headers a browser client
 *  must read: `Retry-After` (429 back-off), and `Content-Disposition` +
 *  `X-Coretax-Invoice-Count` (the Coretax XML export's filename and count). */
export function corsOptions(raw: string | undefined): {
  origin: string[] | false;
  exposedHeaders: string[];
} {
  return {
    origin: parseCorsOrigins(raw),
    exposedHeaders: [
      'Retry-After',
      'Content-Disposition',
      'X-Coretax-Invoice-Count',
    ],
  };
}

/** Hosts a production browser frontend can never be served from. */
function isLoopbackOrUnspecified(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    /^127\.\d+\.\d+\.\d+$/.test(h) ||
    h === '[::1]' ||
    h === '0.0.0.0' ||
    h === '[::]'
  );
}

/** The CORS_ORIGIN entries that are unacceptable in production: `*`, anything
 *  that is not a bare `https://host[:port]` origin, or a loopback/unspecified
 *  host (e.g. the `.env.example` `http://localhost:5173` leaking into prod,
 *  which would silently lock the real frontend out). Unset/empty is fine —
 *  CORS off means server-to-server only. Returns the offending raw entries. */
export function productionCorsViolations(raw: string | undefined): string[] {
  const origins = parseCorsOrigins(raw);
  if (!origins) return [];
  return origins.filter((entry) => {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      return true; // includes '*' and scheme-less hosts
    }
    return (
      url.protocol !== 'https:' ||
      // Exact match: the cors middleware compares the browser's Origin header
      // verbatim, so a trailing '/', path or upper-case host would never match.
      url.origin !== entry ||
      isLoopbackOrUnspecified(url.hostname)
    );
  });
}
