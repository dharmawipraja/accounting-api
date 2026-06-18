/** Human-readable document reference, e.g. JE/2026/000123 or INV/2026/000042. */
export function buildDocRef(prefix: string, fiscalYear: number, num: number): string {
  return `${prefix}/${fiscalYear}/${String(num).padStart(6, '0')}`;
}
