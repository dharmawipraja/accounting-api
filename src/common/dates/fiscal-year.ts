/** Fiscal year that a date falls into, given the configured start month (1-12). */
export function fiscalYearForDate(date: Date, startMonth: number): number {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  return m >= startMonth ? y : y - 1;
}
