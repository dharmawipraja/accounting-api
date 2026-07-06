import { ValidationFailedError } from '../errors/domain-errors';
import { parseDate } from './parse-date';

/** Minutes east of UTC used to resolve a defaulted "today". 420 = WIB (UTC+7):
 *  this is a single-company Indonesian API, so an omitted asOf must mean the
 *  company's calendar day, not the UTC one (a WIB user at 04:00 local is still
 *  "yesterday" in UTC until 07:00). Read at module load like throttle.config. */
export const REPORT_UTC_OFFSET_MINUTES = Number(
  process.env.REPORT_UTC_OFFSET_MINUTES ?? 420,
);

/** A validated as-of query string → Date; missing means *today in the report
 *  timezone* (see REPORT_UTC_OFFSET_MINUTES). The offset-shifted instant
 *  truncates downstream (truncateToUtcDay) to the local calendar day.
 *  Intentionally uses `new Date(asOf)` (not `parseDate`): the default is *today*, not
 *  `undefined`, and `asOf` is already `@IsDateString`-validated at the controller boundary. */
export function asOfOrToday(asOf?: string, now: Date = new Date()): Date {
  return asOf
    ? new Date(asOf)
    : new Date(now.getTime() + REPORT_UTC_OFFSET_MINUTES * 60_000);
}

/** Optional [from, to] filter bounds. Converts each via parseDate; enforces from ≤ to
 *  ONLY when both are present. */
export function optionalDateRange(
  from?: string,
  to?: string,
): { from?: Date; to?: Date } {
  const f = parseDate(from);
  const t = parseDate(to);
  if (f && t && f.getTime() > t.getTime())
    throw new ValidationFailedError('`from` must be on or before `to`', {
      from,
      to,
    });
  return { from: f, to: t };
}

/** Required [from, to] range (report endpoints). Same from ≤ to invariant; both mandatory.
 *  Pass maxDays to also reject spans wider than the endpoint can afford to materialize. */
export function dateRange(
  from: string,
  to: string,
  maxDays?: number,
): { from: Date; to: Date } {
  const { from: f, to: t } = optionalDateRange(from, to);
  if (maxDays !== undefined) {
    const days = Math.round((t!.getTime() - f!.getTime()) / 86_400_000);
    if (days > maxDays)
      throw new ValidationFailedError(
        `date range must not exceed ${maxDays} days`,
        { from, to },
      );
  }
  return { from: f!, to: t! }; // both required strings → both defined
}
