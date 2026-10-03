import { Decimal } from 'decimal.js';
import { Prisma, TaxKind } from '@prisma/client';
import { Money } from '../common/money/money';
import { ValidationFailedError } from '../common/errors/domain-errors';
import { taxBases } from '../tax/tax.service';
import type { CalculatedLine } from '../tax/tax.service';
import type { DocumentLineInput } from './document-descriptor';

/** 40 significant digits (as Money): the pro-rating quotient is exact far past
 *  the single 4dp rounding. */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** The fields of an original invoice/bill line a returned line copies. */
export interface OriginalLine {
  id: string;
  description: string;
  accountId: string;
  quantity: Prisma.Decimal | string;
  unitPrice: Prisma.Decimal | string;
  discountPercent: Prisma.Decimal | string | null;
  discountAmount: Prisma.Decimal | string;
  taxCodeIds: string[];
}

export type NoteLineInput = DocumentLineInput & { originalLineId: string };

/** Pure: the credit/debit-note line returning `quantity` of `orig`.
 *  Description, account, unit price and tax codes are copied. The discount:
 *  - a PERCENT discount keeps the same percent (lineAmounts then takes it off
 *    the returned gross with its usual single 4dp rounding);
 *  - a FIXED discount is pro-rated by quantity: discountAmount × quantity /
 *    original quantity, computed exactly and rounded ONCE to 4dp half-up,
 *    capped at the returned gross (round4(quantity × unitPrice)).
 *  A partial return may be ± 0.0001 off; the note that brings the line to its
 *  full quantity takes the remainder instead (completedLine).
 *  422 for a zero-quantity original line (nothing to return). */
export function returnedLine(
  orig: OriginalLine,
  quantity: string,
): NoteLineInput {
  if (Money.of(orig.quantity.toString()).isZero())
    throw new ValidationFailedError(
      'Original line has zero quantity; nothing to return',
      { originalLineId: orig.id },
    );
  const base = {
    originalLineId: orig.id,
    description: orig.description,
    accountId: orig.accountId,
    quantity,
    unitPrice: orig.unitPrice.toString(),
    taxCodeIds: [...orig.taxCodeIds],
  };
  if (orig.discountPercent !== null)
    return {
      ...base,
      discountPercent: orig.discountPercent.toString(),
      discountAmount: null,
    };
  const gross = Money.of(base.unitPrice).multiply(quantity);
  const prorated = Money.of(
    new D(orig.discountAmount.toString())
      .times(quantity)
      .div(orig.quantity.toString()),
  );
  return {
    ...base,
    discountPercent: null,
    discountAmount: (prorated.greaterThan(gross)
      ? gross
      : prorated
    ).toPersistence(),
  };
}

/** Pure: the returned line that brings its original line to its FULL
 *  quantity takes the remainder — its discount is set (as a fixed amount) so
 *  its amount = the original line's amount − what every other live note
 *  already returns of it (`remainingAmount`), clamped to [0, gross]. With an
 *  exact gross (whole quantities) that is exactly the original discount − the
 *  discounts already returned; so whole returns sum to the original line. */
export function completedLine(
  line: NoteLineInput,
  remainingAmount: string,
): NoteLineInput {
  const gross = Money.of(line.unitPrice).multiply(line.quantity);
  const discount = gross.subtract(Money.of(remainingAmount));
  const clamped = discount.isNegative()
    ? Money.zero()
    : discount.greaterThan(gross)
      ? gross
      : discount;
  return {
    ...line,
    discountPercent: null,
    discountAmount: clamped.toPersistence(),
  };
}

/** Per tax code, what a note may still credit/debit of its original: the
 *  original's posted (rupiah-rounded) amount − what every OTHER live note
 *  takes (`remaining`), and whether every original line carrying the code is
 *  fully returned once this note counts (`complete`). */
export type NoteTaxPlan = Record<
  string,
  { remaining: string; complete: boolean }
>;

interface PlanLine {
  amount: string;
  taxCodeIds: string[];
}

const isPpn = (kind: TaxKind) => kind === 'PPN_OUTPUT' || kind === 'PPN_INPUT';

/** Per-code rupiah amounts of `lines` (TaxService rounding: base × rate,
 *  rounded once per code). */
function codeAmounts(
  lines: PlanLine[],
  codes: Map<string, { rate: string; kind: TaxKind }>,
): Map<string, Money> {
  const out = new Map<string, Money>();
  for (const [id, base] of taxBases(lines)) {
    const c = codes.get(id);
    if (c) out.set(id, base.multiplyToRupiah(c.rate));
  }
  return out;
}

/** Pure: the tax plan of a note (see NoteTaxPlan). Another note's per-code
 *  amounts are rebuilt from its lines and fitted to its STORED PPN/PPh totals
 *  (taxTotal / withholdingTotal: what it actually takes, including its own
 *  remainder/cap), any difference going to its largest code of that bucket —
 *  exact whenever a note carries one code per bucket (one PPN + one PPh). */
export function noteTaxPlan(input: {
  codes: Map<string, { rate: string; kind: TaxKind }>;
  /** Every original line; `complete` = fully returned once this note counts. */
  original: (PlanLine & { complete: boolean })[];
  others: { lines: PlanLine[]; taxTotal: string; withholdingTotal: string }[];
}): NoteTaxPlan {
  const remaining = codeAmounts(input.original, input.codes);
  for (const other of input.others) {
    const raw = codeAmounts(other.lines, input.codes);
    for (const ppn of [true, false]) {
      const ids = [...raw.keys()]
        .filter((id) => isPpn(input.codes.get(id)!.kind) === ppn)
        .sort((a, b) =>
          raw.get(b)!.greaterThan(raw.get(a)!)
            ? 1
            : raw.get(a)!.greaterThan(raw.get(b)!)
              ? -1
              : a.localeCompare(b),
        );
      if (ids.length === 0) continue;
      const stored = Money.of(ppn ? other.taxTotal : other.withholdingTotal);
      const delta = stored.subtract(Money.sum(ids.map((id) => raw.get(id)!)));
      raw.set(ids[0], raw.get(ids[0])!.add(delta));
    }
    for (const [id, amt] of raw)
      remaining.set(id, (remaining.get(id) ?? Money.zero()).subtract(amt));
  }
  const plan: NoteTaxPlan = {};
  for (const [id, rem] of remaining)
    plan[id] = {
      remaining: rem.toPersistence(),
      complete: input.original.every(
        (l) => l.complete || !l.taxCodeIds.includes(id),
      ),
    };
  return plan;
}

/** Pure: the note's per-code tax amounts from its raw (rupiah-rounded) ones —
 *  the code's remainder when the note completes it (every original line
 *  carrying it fully returned), else the raw amount capped at the remainder;
 *  never below 0. So the live notes of a code never take more than the
 *  original, and whole returns take exactly the original. */
export function noteTaxAmounts(
  raw: readonly { taxCodeId: string; amount: string }[],
  plan: NoteTaxPlan,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of raw) {
    const p = plan[t.taxCodeId];
    if (!p) continue;
    const rem = Money.of(p.remaining).isNegative()
      ? Money.zero()
      : Money.of(p.remaining);
    const amt = Money.of(t.amount);
    out[t.taxCodeId] = (
      p.complete || amt.greaterThan(rem) ? rem : amt
    ).toPersistence();
  }
  return out;
}

/** Pure: how a note's settlement amount splits — `applied` settles the
 *  original (up to its outstanding), the `excess` becomes partner credit. */
export function splitSettlement(
  settlement: string,
  outstanding: string,
): { applied: string; excess: string } {
  const total = Money.of(settlement);
  const open = Money.of(outstanding);
  const applied = open.isNegative()
    ? Money.zero()
    : open.greaterThan(total)
      ? total
      : open;
  return {
    applied: applied.toPersistence(),
    excess: total.subtract(applied).toPersistence(),
  };
}

/** Pure: a note's journal = the mirror of the original's for the returned
 *  part. `lines` is the tax engine's journal for the note's lines (last line =
 *  the AR/AP settlement): every line swaps sides, and the settlement splits
 *  into AR/AP `applied` + advance-account `excess` (zero parts left out):
 *    sales credit note    Dr revenue, Dr PPN Keluaran / Cr PPh prepaid (or
 *                         final-expense), Cr AR applied, Cr Uang Muka Pelanggan excess
 *    purchase debit note  Dr AP applied, Dr Uang Muka Pembelian excess, Dr PPh
 *                         payable / Cr expense, Cr PPN Masukan */
export function noteJournalLines(
  lines: CalculatedLine[],
  settlementAccountId: string,
  split: { applied: string; excess: string; advanceAccountId?: string },
): CalculatedLine[] {
  const settlement = lines[lines.length - 1];
  if (!settlement || settlement.accountId !== settlementAccountId)
    throw new Error('Tax journal has no trailing settlement line');
  const mirror = (l: CalculatedLine): CalculatedLine =>
    l.debit !== undefined
      ? { accountId: l.accountId, credit: l.debit }
      : { accountId: l.accountId, debit: l.credit };
  const side = settlement.debit !== undefined ? 'credit' : 'debit';
  const parts = [
    { accountId: settlementAccountId, amount: split.applied },
    { accountId: split.advanceAccountId ?? '', amount: split.excess },
  ].filter((p) => !Money.of(p.amount).isZero());
  return [
    ...lines.slice(0, -1).map(mirror),
    ...parts.map((p) => ({ accountId: p.accountId, [side]: p.amount })),
  ];
}
