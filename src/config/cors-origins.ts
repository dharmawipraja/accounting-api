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

/** The app's CORS options. `Retry-After` is exposed so a browser client can
 *  read the back-off on a 429 (it is not a CORS-safelisted response header). */
export function corsOptions(raw: string | undefined): {
  origin: string[] | false;
  exposedHeaders: string[];
} {
  return { origin: parseCorsOrigins(raw), exposedHeaders: ['Retry-After'] };
}
