/** Fiscal year that a date falls into, given the configured start month (1-12). */
export function fiscalYearForDate(date: Date, startMonth: number): number {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  return m >= startMonth ? y : y - 1;
}

/** First UTC day of a fiscal year, given the configured start month (1-12). */
export function fiscalYearStartDate(
  fiscalYear: number,
  startMonth: number,
): Date {
  return new Date(Date.UTC(fiscalYear, startMonth - 1, 1));
}

/** Last UTC day of a fiscal year, given the configured start month (1-12). */
export function fiscalYearEndDate(
  fiscalYear: number,
  startMonth: number,
): Date {
  const endYear = startMonth === 1 ? fiscalYear : fiscalYear + 1;
  const endMonth0 = startMonth === 1 ? 11 : startMonth - 2; // 0-based last month
  return new Date(Date.UTC(endYear, endMonth0 + 1, 0)); // day 0 of next month = last day
}
