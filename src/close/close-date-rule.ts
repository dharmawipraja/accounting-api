import { truncateToUtcDay } from '../common/dates/utc-day';

/** Pure rule: a fiscal year may be closed only once it has ended — its last
 *  day on/before `today` (the company's calendar day, WIB; see asOfOrToday).
 *  Closing earlier would zero a P&L that later postings (the year is then
 *  locked) could never complete. Returns the 422 details, or null. */
export function yearNotEndedViolation(
  fiscalYear: number,
  yearEnd: Date,
  today: Date,
): { fiscalYear: number; yearEnd: string } | null {
  if (truncateToUtcDay(yearEnd).getTime() <= truncateToUtcDay(today).getTime())
    return null;
  return { fiscalYear, yearEnd: yearEnd.toISOString().slice(0, 10) };
}
