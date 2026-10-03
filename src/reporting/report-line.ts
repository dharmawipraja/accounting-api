import { Money } from '../common/money/money';

export interface ReportLine {
  code: string;
  name: string;
  amount: string;
}

/** One account's figure in both periods. Balance-sheet lines also carry the
 *  subtype group they sit in. */
export interface VarianceLine {
  subtype?: string;
  code: string;
  name: string;
  current: string;
  comparative: string;
  variance: string; // current − comparative
}

/** Per-line variance over the UNION of both periods' lines (an account present
 *  in only one period counts 0 in the other): current-period order first, then
 *  comparative-only lines in their order. Keyed by subtype + code, so the
 *  balance sheet's synthetic equity lines (code '') stay distinct. */
export function varianceLines(
  current: (ReportLine & { subtype?: string })[],
  comparative: (ReportLine & { subtype?: string })[],
): VarianceLine[] {
  const key = (l: { subtype?: string; code: string }) =>
    `${l.subtype ?? ''}|${l.code}`;
  const cmp = new Map(comparative.map((l) => [key(l), l]));
  const out: VarianceLine[] = current.map((l) => {
    const c = cmp.get(key(l));
    cmp.delete(key(l));
    return line(l, l.amount, c?.amount ?? '0');
  });
  for (const c of cmp.values()) out.push(line(c, '0', c.amount));
  return out;
}

function line(
  l: ReportLine & { subtype?: string },
  current: string,
  comparative: string,
): VarianceLine {
  const cur = Money.of(current);
  const cmp = Money.of(comparative);
  return {
    ...(l.subtype !== undefined && { subtype: l.subtype }),
    code: l.code,
    name: l.name,
    current: cur.toPersistence(),
    comparative: cmp.toPersistence(),
    variance: cur.subtract(cmp).toPersistence(),
  };
}

/** `current[k] − comparative[k]` for each money field `k`. */
export function moneyVariance<K extends string>(
  current: Record<K, string>,
  comparative: Record<K, string>,
  keys: readonly K[],
): Record<K, string> {
  return Object.fromEntries(
    keys.map((k) => [
      k,
      Money.of(current[k]).subtract(Money.of(comparative[k])).toPersistence(),
    ]),
  ) as Record<K, string>;
}
