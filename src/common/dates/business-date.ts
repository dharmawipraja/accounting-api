import { ValidationFailedError } from '../errors/domain-errors';

const LEADING_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** The shared business-date transformer. A business date (journal/document/
 *  payment date, due date, report asOf/from/to) is a calendar day, not an
 *  instant: take the `YYYY-MM-DD` from the first 10 chars of the (already
 *  @IsDateString-validated) string and return that day at UTC midnight — the
 *  shape every `@db.Date` column and period bound uses. Any time-of-day or
 *  offset is ignored, so `2026-07-01T00:30+07:00` is July 1, never shifted to
 *  June 30 by a UTC conversion. 422 if the leading date is not a real day. */
export function businessDate(value: string): Date {
  const date = leadingCalendarDay(value);
  if (date) return date;
  throw new ValidationFailedError(
    'Invalid calendar date; expected YYYY-MM-DD',
    {
      value,
    },
  );
}

/** Pure DTO-boundary check (IsBusinessDate): does the string start with a real
 *  calendar day? `2026-02-30` is ISO-shaped but not a day → false (400). */
export function isBusinessDateString(value: unknown): boolean {
  return typeof value === 'string' && leadingCalendarDay(value) !== null;
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
