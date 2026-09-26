import { isBusinessDateString } from './business-date';

/** Convert an optional ISO date string from a validated DTO into a Date (or undefined). */
export function parseDate(value?: string | null): Date | undefined {
  return value ? new Date(value) : undefined;
}

/** `YYYY-MM-DD`, optionally `THH:MM[:SS[.fraction]]` and a `Z` / `±HH[:]MM`
 *  offset — the only shapes an audit-log `from` / `to` filter accepts (no
 *  week / ordinal / basic / expanded-year ISO forms). */
const AUDIT_INSTANT =
  /^(\d{4})-\d{2}-\d{2}(?:T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?)?$/;

export const AUDIT_YEAR_MIN = 1970;
export const AUDIT_YEAR_MAX = 9999;

/** Pure DTO-boundary check (`@IsAuditInstant()`) for the audit-log
 *  `from` / `to` instants: the strict shape above, a REAL calendar day
 *  (`2026-02-30` → false — `new Date` would silently roll it to March 2),
 *  a year in 1970–9999 (year 0000 used to reach Postgres as an
 *  out-of-range timestamp → 500), and parseable by `new Date`. */
export function isAuditInstantString(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const m = AUDIT_INSTANT.exec(value);
  if (!m || !isBusinessDateString(value)) return false;
  const year = Number(m[1]);
  return (
    year >= AUDIT_YEAR_MIN &&
    year <= AUDIT_YEAR_MAX &&
    !Number.isNaN(new Date(value).getTime())
  );
}
