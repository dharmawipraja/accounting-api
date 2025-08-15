import { endOfDay, parseISO, startOfDay } from 'date-fns';
import { fromZonedTime } from 'date-fns-tz';

// Convert a date string or Date to a UTC Date using an app timezone.
// Options:
//  - mode: 'exact' | 'startOfDay' | 'endOfDay'
export const toUtcFromLocal = (value, timeZone = 'UTC', opts = { mode: 'exact' }) => {
  if (!value) return new Date();

  let date = value;
  if (typeof value === 'string') {
    date = parseISO(value);
  }

  if (!(date instanceof Date)) date = new Date(date);

  if (opts.mode === 'startOfDay') date = startOfDay(date);
  if (opts.mode === 'endOfDay') date = endOfDay(date);

  // fromZonedTime converts a date in the given zone to the equivalent UTC Date
  return fromZonedTime(date, timeZone);
};

export default { toUtcFromLocal };
