import { Money } from './money';

/**
 * Returns a shallow copy of `obj` with each named field rendered to a fixed
 * 4-decimal money string via Money. null/undefined named fields pass through.
 * Other fields are untouched. This is the single home for the Decimal→string
 * money cast that the document presenters used to repeat per field.
 */
export function serializeMoney<T extends object>(
  obj: T,
  fields: (keyof T)[],
): T {
  const out: T = { ...obj };
  for (const f of fields) {
    const v = obj[f];
    if (v !== null && v !== undefined) {
      (out[f] as unknown) = Money.of(String(v)).toPersistence();
    }
  }
  return out;
}
