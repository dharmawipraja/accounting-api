import { ValidationFailedError } from '../errors/domain-errors';
import { asOfOrToday } from './query-dates';
import { truncateToUtcDay } from './utc-day';

/** Pure rule: an explicit void / reversal date may not be in the future —
 *  it must fall on/before `today` (the company's calendar day, WIB; see
 *  asOfOrToday), consistent with the year-end close rule. Returns the 422
 *  details `{ date, today }`, or null. */
export function futureDateViolation(
  date: Date,
  today: Date,
): { date: string; today: string } | null {
  const day = truncateToUtcDay(today);
  if (truncateToUtcDay(date).getTime() <= day.getTime()) return null;
  return {
    date: date.toISOString().slice(0, 10),
    today: day.toISOString().slice(0, 10),
  };
}

/** Throws 422 VALIDATION_FAILED `{ date, today }` when `date` is after today
 *  (WIB). Used for the client-supplied date of a void (invoice / bill /
 *  payment) and of a generic journal reversal; a no-body void (original
 *  date) never calls it. */
export function assertNotAfterToday(
  date: Date,
  message: string,
  today: Date = asOfOrToday(),
): void {
  const v = futureDateViolation(date, today);
  if (v) throw new ValidationFailedError(message, v);
}
