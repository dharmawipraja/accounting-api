/** Suffix a unique value so it is freed for reuse while the row is soft-deleted. */
export function tombstoneValue(value: string, id: string): string {
  return `${value}#deleted-${id}`;
}

/** Update `data` that soft-deletes row `id`: frees its unique `field` (via
 *  tombstoneValue) and stamps deletedAt/deletedBy. Works on the client or a `tx`. */
export function tombstoneData<K extends string>(
  field: K,
  currentValue: string,
  id: string,
  deletedBy: string,
) {
  return {
    [field]: tombstoneValue(currentValue, id),
    deletedAt: new Date(),
    deletedBy,
  } as Record<K, string> & { deletedAt: Date; deletedBy: string };
}
