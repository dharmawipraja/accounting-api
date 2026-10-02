import { ValidationFailedError } from '../errors/domain-errors';

const LEADING_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** The shared business-date transformer. A business date (journal/document/
 *  payment date, due date, report asOf/from/to) is a calendar day, not an
 *  instant, so it must be exactly `YYYY-MM-DD`: a timestamp is ambiguous
 *  (`new Date().toISOString()` at 00:30 WIB on July 1 reads `2026-06-30T17:30Z`
 *  and would post to June 30). Returns that day at UTC midnight — the shape
 *  every `@db.Date` column and period bound uses. 422 if not a real day. */
export function businessDate(value: string): Date {
  const date = DATE_ONLY.test(value) ? leadingCalendarDay(value) : null;
  if (date) return date;
  throw new ValidationFailedError(
    'Invalid calendar date; expected YYYY-MM-DD',
    {
      value,
    },
  );
}

/** Pure DTO-boundary check (IsBusinessDate): exactly `YYYY-MM-DD` and a real
 *  calendar day (`2026-02-30` is ISO-shaped but not a day → false, 400). */
export function isBusinessDateString(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    DATE_ONLY.test(value) &&
    leadingCalendarDay(value) !== null
  );
}

/** Does the string START with a real calendar day? For timestamp inputs
 *  (audit-log `from`/`to`) whose day part must still be a real day. */
export function hasRealLeadingDay(value: string): boolean {
  return leadingCalendarDay(value) !== null;
}

function leadingCalendarDay(value: string): Date | null {
  const m = LEADING_DATE.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
    ? date
    : null;
}

/** `businessDate` for an optional input: absent/empty → undefined. */
export function optionalBusinessDate(value?: string | null): Date | undefined {
  return value ? businessDate(value) : undefined;
}

/** PATCH tri-state for a nullable business date: `undefined` (omitted → keep
 *  the stored value), `null` (explicitly cleared), or the parsed date. */
export function patchBusinessDate(
  value?: string | null,
): Date | null | undefined {
  if (value === null) return null;
  return optionalBusinessDate(value);
}
