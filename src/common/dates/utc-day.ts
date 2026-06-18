/** Truncate a Date to UTC midnight (drops time-of-day). */
export function truncateToUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}
