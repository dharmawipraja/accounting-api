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
  const m = LEADING_DATE.exec(value);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const date = new Date(Date.UTC(y, mo - 1, d));
    if (
      date.getUTCFullYear() === y &&
      date.getUTCMonth() === mo - 1 &&
      date.getUTCDate() === d
    )
      return date;
  }
  throw new ValidationFailedError(
    'Invalid calendar date; expected YYYY-MM-DD',
    {
      value,
    },
  );
}

/** `businessDate` for an optional input: absent/empty → undefined. */
export function optionalBusinessDate(value?: string | null): Date | undefined {
  return value ? businessDate(value) : undefined;
}
