import { ValidationFailedError } from '../errors/domain-errors';
import { asOfOrToday } from './query-dates';
import { truncateToUtcDay } from './utc-day';

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Pure rule: an explicit void / reversal date may not be in the future —
 *  it must fall on/before `today` (the company's calendar day, WIB; see
 *  asOfOrToday), consistent with the year-end close rule — EXCEPT that a
 *  future-dated original (document / entry dated after today) may always be
 *  voided / reversed on its own date: the ceiling is
 *  `max(today, originalDate)` (matching the no-body
 *  void, which defaults to the original date). The floor
 *  (`date >= originalDate`) is checked separately (assertVoidDateNotBefore /
 *  the posting reversal). Returns the 422 details `{ date, today }` (plus
 *  `originalDate` when it, not today, is the ceiling), or null. */
export function futureDateViolation(
  date: Date,
  today: Date,
  originalDate?: Date,
): { date: string; today: string; originalDate?: string } | null {
  const day = truncateToUtcDay(today);
  const original = originalDate ? truncateToUtcDay(originalDate) : undefined;
  const ceiling =
    original && original.getTime() > day.getTime() ? original : day;
  if (truncateToUtcDay(date).getTime() <= ceiling.getTime()) return null;
  return {
    date: isoDay(date),
    today: isoDay(day),
    ...(ceiling === original ? { originalDate: isoDay(original) } : {}),
  };
}

/** Throws 422 VALIDATION_FAILED `{ date, today[, originalDate] }` when
 *  `date` is after `max(today (WIB), originalDate)`. Used for the
 *  client-supplied date of a void (invoice / bill / payment) and of a generic
 *  journal reversal (`originalDate` = the document / entry date); a no-body
 *  void (original date) never calls it. */
export function assertNotAfterToday(
  date: Date,
  message: string,
  opts: { today?: Date; originalDate?: Date } = {},
): void {
  const v = futureDateViolation(
    date,
    opts.today ?? asOfOrToday(),
    opts.originalDate,
  );
  if (v) throw new ValidationFailedError(message, v);
}
