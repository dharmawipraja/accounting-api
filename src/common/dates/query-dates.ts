import { ValidationFailedError } from '../errors/domain-errors';
import { parseDate } from './parse-date';

/** A validated as-of query string → Date; missing means *today*.
 *  Intentionally uses `new Date(asOf)` (not `parseDate`): the default is *today*, not
 *  `undefined`, and `asOf` is already `@IsDateString`-validated at the controller boundary. */
export function asOfOrToday(asOf?: string): Date {
  return asOf ? new Date(asOf) : new Date();
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

/** Required [from, to] range (report endpoints). Same from ≤ to invariant; both mandatory. */
export function dateRange(from: string, to: string): { from: Date; to: Date } {
  const { from: f, to: t } = optionalDateRange(from, to);
  return { from: f!, to: t! }; // both required strings → both defined
}
