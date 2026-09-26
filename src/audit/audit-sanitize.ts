import { toStorableString } from '../common/text/unicode-hygiene';

const SENSITIVE = /password|token|secret|authorization/i;

/** `value` as JSON Postgres' jsonb will always accept: every string (object
 *  keys included) passed through `toStorableString` (U+0000 removed, lone
 *  surrogates → U+FFFD), and objects rebuilt with a NULL prototype, so a
 *  `__proto__` / `constructor` / `prototype` key is stored as plain data
 *  (assigning `out['__proto__']` on a `{}` would set the prototype and drop
 *  the key). `redact` additionally replaces the value of a sensitive key.
 *  Recursive: request bodies reach it capped at MAX_BODY_DEPTH (jsonDepthGuard). */
function storable(value: unknown, redact: boolean): unknown {
  if (typeof value === 'string') return toStorableString(value);
  if (Array.isArray(value)) return value.map((v) => storable(v, redact));
  if (value && typeof value === 'object') {
    const out = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[toStorableString(k)] =
        redact && SENSITIVE.test(k) ? '[REDACTED]' : storable(v, redact);
    }
    return out;
  }
  return value;
}

/** Recursively redact sensitive keys in a request body for safe audit
 *  storage — and make it storable (see `storable`). Pure. */
export function sanitize(value: unknown): unknown {
  return storable(value, true);
}

/** Storable-JSON repair only (no redaction) — AuditService applies it to every
 *  row's params / body, whoever built them, so a row is never lost to its
 *  content. Idempotent. Pure. */
export function toStorableJson(value: unknown): unknown {
  return storable(value, false);
}
