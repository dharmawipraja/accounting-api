import { Money } from '../common/money/money';
import { serializeMoney } from '../common/money/serialize-money';
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
    onlyPostedVoid: `Only a POSTED ${l.noun} can be voided`,
    voidWithPaymentsFirst: `Cannot void ${l.article} ${l.noun} with payments; void the payments first`,
    voidWithPayments: `Cannot void ${l.article} ${l.noun} with payments`,
    alreadyReversed: `${N} journal entry was already reversed`,
    notPosted: `${N} is not posted`,
    defaultDescription: (id: string) => `${l.label} ${id}`,
  };
}

/** Map caller line inputs to Prisma nested-create rows (amount = qty*unitPrice, 4dp). */
export function buildLineCreateData(
  lines: DocumentLineInput[],
): DocumentLineCreateData[] {
  return lines.map((l, i) => ({
    lineNo: i + 1,
    description: l.description,
    accountId: l.accountId,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    amount: Money.of(l.unitPrice).multiply(l.quantity).toPersistence(),
    taxCodeIds: l.taxCodeIds,
  }));
}

/** Shape an API response: 4dp money strings + derived outstanding/paymentStatus.
 *  Generic over any taxed-document row. */
export function presentDocument<T extends DocumentRow>(
  doc: T,
): T & { outstanding: string; paymentStatus: string } {
  const total = Money.of(doc.total.toString());
  const paid = Money.of(doc.amountPaid.toString());
  const outstanding = total.subtract(paid);
  const paymentStatus = paid.isZero()
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
    ]),
    ...(lines
      ? {
          lines: lines.map((l) =>
            serializeMoney(l, ['quantity', 'unitPrice', 'amount']),
          ),
        }
      : {}),
    outstanding: outstanding.toPersistence(),
    paymentStatus,
  };
}
