import { Prisma } from '@prisma/client';
import { Money } from '../common/money/money';
import { serializeMoney } from '../common/money/serialize-money';
import { lineAmounts } from './document-helpers';
import {
  DocumentRow,
  DocumentLineInput,
  DocumentLineCreateData,
  DocumentLabels,
} from './document-descriptor';

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function partnerKind(
  flag: 'isCustomer' | 'isVendor',
): 'customer' | 'vendor' {
  return flag === 'isCustomer' ? 'customer' : 'vendor';
}

/** Every user-facing message for a taxed trade document, byte-for-byte identical
 *  to the strings the two services produced before the collapse. */
export function documentMessages(l: DocumentLabels) {
  const N = cap(l.noun);
  return {
    partnerInactive: `Partner is not an active ${partnerKind(l.partnerFlag)}`,
    notFound: `${l.label} not found`,
    onlyDraftEdit: `Only a DRAFT ${l.noun} can be edited`,
    notADraft: `${N} is not a draft`,
    noLongerDraft: `${N} is no longer a draft`,
    changedDuringPost: `${N} was changed while being posted (document, tax code or partner state); retry`,
    onlyPostedVoid: `Only a POSTED ${l.noun} can be voided`,
    voidWithPaymentsFirst: `Cannot void ${l.article} ${l.noun} with payments; void the payments first`,
    voidWithPayments: `Cannot void ${l.article} ${l.noun} with payments`,
    alreadyReversed: `${N} journal entry was already reversed`,
    notPosted: `${N} is not posted`,
    defaultDescription: (id: string) => `${l.label} ${id}`,
  };
}

/** Map caller line inputs to Prisma nested-create rows (amount = NET of the
 *  line discount, 4dp — see lineAmounts). */
export function buildLineCreateData(
  lines: DocumentLineInput[],
): DocumentLineCreateData[] {
  return lines.map((l, i) => ({
    lineNo: i + 1,
    description: l.description,
    accountId: l.accountId,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    ...lineAmounts(l, i + 1),
    taxCodeIds: l.taxCodeIds,
  }));
}

/** Shape an API response: 4dp money strings + derived outstanding/paymentStatus
 *  (outstanding = total − amountPaid − creditedTotal).
 *  Generic over any taxed-document row. */
export function presentDocument<T extends DocumentRow>(
  doc: T,
): T & { outstanding: string; paymentStatus: string } {
  const total = Money.of(doc.total.toString());
  // Settled = payments + POSTED credit/debit notes (creditedTotal).
  const settled = Money.of(doc.amountPaid.toString()).add(
    Money.of(doc.creditedTotal.toString()),
  );
  const outstanding = total.subtract(settled);
  const paymentStatus = settled.isZero()
    ? 'UNPAID'
    : outstanding.isZero() || outstanding.isNegative()
      ? 'PAID'
      : 'PARTIAL';
  // Widen the typed lines to a generic record so serializeMoney can map them;
  // DocumentRow.lines is narrower than serializeMoney's object-field parameter.
  const lines = (doc as DocumentRow & { lines?: Record<string, unknown>[] })
    .lines;
  return {
    ...serializeMoney(doc, [
      'subtotal',
      'taxTotal',
      'withholdingTotal',
      'total',
      'amountPaid',
      'creditedTotal',
      'discountTotal',
    ]),
    ...(lines ? { lines: presentLines(lines) } : {}),
    outstanding: outstanding.toPersistence(),
    paymentStatus,
  };
}

/** A document / note line's money columns, 4dp strings in responses. */
const LINE_MONEY = [
  'quantity',
  'unitPrice',
  'discountPercent',
  'discountAmount',
  'amount',
] as const;

/** API shape of document / note lines: 4dp money strings. */
export function presentLines<
  T extends Record<(typeof LINE_MONEY)[number], unknown>,
>(lines: T[]): T[] {
  return lines.map((l) => serializeMoney(l, [...LINE_MONEY]));
}

/** A credit holder's payment_applications rows as the API shows them: onto
 *  documents (`applications`) and cash refunds (`refunds`, cashAccountId
 *  set), 4dp money. */
export function presentApplications<
  T extends { cashAccountId: string | null; amount: Prisma.Decimal },
>(rows: T[]) {
  const shown = rows.map((a) => serializeMoney(a, ['amount']));
  return {
    applications: shown.filter((a) => a.cashAccountId === null),
    refunds: shown.filter((a) => a.cashAccountId !== null),
  };
}
