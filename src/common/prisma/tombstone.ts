/** Suffix a unique value so it is freed for reuse while the row is soft-deleted. */
export function tombstoneValue(value: string, id: string): string {
  return `${value}#deleted-${id}`;
}
