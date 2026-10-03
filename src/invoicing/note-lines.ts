import { Decimal } from 'decimal.js';
import { Prisma } from '@prisma/client';
import { Money } from '../common/money/money';
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
 *  Several partial returns of one line may therefore sum to the original
 *  discount ± 0.0001 per note (each is rounded on its own). */
export function returnedLine(
  orig: OriginalLine,
  quantity: string,
): NoteLineInput {
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
