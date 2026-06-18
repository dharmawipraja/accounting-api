/** Convert an optional ISO date string from a validated DTO into a Date (or undefined). */
export function parseDate(value?: string | null): Date | undefined {
  return value ? new Date(value) : undefined;
}
