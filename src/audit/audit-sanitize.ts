const SENSITIVE = /password|token|secret|authorization/i;

/** Recursively redact sensitive keys in a request body for safe audit storage. */
export function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? '[REDACTED]' : sanitize(v);
    }
    return out;
  }
  return value;
}
