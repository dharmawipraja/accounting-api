import {
  AccountRole,
  DocumentStatus,
  PaymentDirection,
  Prisma,
} from '@prisma/client';
import { Money } from '../common/money/money';
import { LedgerTx } from '../ledger/posting/posting.service';
import { ExtendedPrismaClient } from '../common/prisma/soft-delete.extension';
import {
  ConflictDomainError,
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';

export interface AllocationInput {
  salesInvoiceId?: string;
  purchaseBillId?: string;
  amount: string;
}

/** Normalized read of the document a payment allocation settles. */
export interface TargetRow {
  id: string;
  partnerId: string;
  status: DocumentStatus;
  date: Date;
  total: Prisma.Decimal;
  amountPaid: Prisma.Decimal;
}

/** One line of a payment's 2-line cash/control journal. */
export interface PaymentJournalLine {
  accountId: string;
  debit?: string;
  credit?: string;
}

/** The document a payment allocation settles, per direction:
 *  RECEIPT → sales invoice (AR); DISBURSEMENT → purchase bill (AP). */
export interface PaymentTarget {
  direction: PaymentDirection;
  partnerFlag: 'isCustomer' | 'isVendor';
  partnerRequiredMessage: string;
  controlRole: AccountRole;
  numberPrefix: 'PAY-RCV' | 'PAY-DSB';
  /** Constant union literal — never user input; safe for Prisma.raw. */
  table: 'sales_invoices' | 'purchase_bills';
  noun: string; // short: 'invoice' | 'bill' (post-path messages)
  label: string; // long: 'sales invoice' | 'purchase bill' (loadTarget messages)
  cashIsDebit: boolean;
  allocId(a: AllocationInput): string | undefined;
  otherId(a: AllocationInput): string | undefined;
  find(client: ExtendedPrismaClient, id: string): Promise<TargetRow | null>;
  applyPaid(
    tx: LedgerTx,
    id: string,
    amount: Prisma.Decimal,
    sign: 1 | -1,
  ): Promise<void>;
}

export const PAYMENT_TARGETS: Record<PaymentDirection, PaymentTarget> = {
  RECEIPT: {
    direction: 'RECEIPT',
    partnerFlag: 'isCustomer',
    partnerRequiredMessage: 'Receipt requires a customer',
    controlRole: 'AR_CONTROL',
    numberPrefix: 'PAY-RCV',
    table: 'sales_invoices',
    noun: 'invoice',
    label: 'sales invoice',
    cashIsDebit: true,
    allocId: (a) => a.salesInvoiceId,
    otherId: (a) => a.purchaseBillId,
    find: async (client, id) => {
      const inv = await client.salesInvoice.findFirst({ where: { id } });
      return inv
        ? {
            id: inv.id,
            partnerId: inv.partnerId,
            status: inv.status,
            date: inv.date,
            total: inv.total,
            amountPaid: inv.amountPaid,
          }
        : null;
    },
    applyPaid: async (tx, id, amount, sign) => {
      await tx.salesInvoice.update({
        where: { id },
        data: {
          amountPaid:
            sign === 1 ? { increment: amount } : { decrement: amount },
        },
      });
    },
  },
  DISBURSEMENT: {
    direction: 'DISBURSEMENT',
    partnerFlag: 'isVendor',
    partnerRequiredMessage: 'Disbursement requires a vendor',
    controlRole: 'AP_CONTROL',
    numberPrefix: 'PAY-DSB',
    table: 'purchase_bills',
    noun: 'bill',
    label: 'purchase bill',
    cashIsDebit: false,
    allocId: (a) => a.purchaseBillId,
    otherId: (a) => a.salesInvoiceId,
    find: async (client, id) => {
      const bill = await client.purchaseBill.findFirst({ where: { id } });
      return bill
        ? {
            id: bill.id,
            partnerId: bill.partnerId,
            status: bill.status,
            date: bill.date,
            total: bill.total,
            amountPaid: bill.amountPaid,
          }
        : null;
    },
    applyPaid: async (tx, id, amount, sign) => {
      await tx.purchaseBill.update({
        where: { id },
        data: {
          amountPaid:
            sign === 1 ? { increment: amount } : { decrement: amount },
        },
      });
    },
  },
};

/** Pure over-allocation check: does settling `amount` drive the document past its
 *  outstanding (total − amountPaid)? No I/O. Exact-boundary is allowed (not exceeding). */
export function exceedsOutstanding(
  total: Prisma.Decimal,
  amountPaid: Prisma.Decimal,
  amount: string,
): boolean {
  return Money.of(total.toString())
    .subtract(Money.of(amountPaid.toString()))
    .subtract(Money.of(amount))
    .isNegative();
}

/** Pure payment-date rule: a payment may not be dated before any document it
 *  settles — otherwise, for as-of dates in between, AR/AP control would carry
 *  the payment while aging has no open document to age it against. Returns the
 *  422 details, or null when the dates are fine. */
export function paymentDateViolation(
  paymentDate: Date,
  document: { id: string; date: Date },
): { paymentDate: string; documentId: string; documentDate: string } | null {
  if (paymentDate.getTime() >= document.date.getTime()) return null;
  return {
    paymentDate: paymentDate.toISOString().slice(0, 10),
    documentId: document.id,
    documentDate: document.date.toISOString().slice(0, 10),
  };
}

/** Throws the 422 for a paymentDateViolation. */
export function assertPaymentDateNotBefore(
  paymentDate: Date,
  document: { id: string; date: Date },
): void {
  const v = paymentDateViolation(paymentDate, document);
  if (v)
    throw new ValidationFailedError(
      'Payment date cannot be before the date of a document it allocates to',
      v,
    );
}

/** Pure backdated-void rule. The as-of aging counts a payment's allocation on
 *  day D iff the payment is dated on/before D and is POSTED or was voided
 *  AFTER D (a VOID payment stays live on [date, voidedOn)). A new payment
 *  dated P adds `amount` to every day D ≥ P, so it is safe iff
 *  max over D ≥ P of the other payments' live allocations + amount ≤ total —
 *  otherwise, for those past days, aging would drop the (over-paid) document
 *  while AR/AP control still carried the excess. `peakLivePaid` is that max
 *  (see allocationHistoryAfter). Only a later-voided payment can make it
 *  exceed what the current outstanding check allows, so without one this is
 *  null (plain over-allocation stays the outstanding check's 409/422).
 *  `latestVoidedOn` is the latest void date after P: a payment dated on/after
 *  it never overlaps a voided payment's live window. */
export function backdatedAllocationViolation(args: {
  documentId: string;
  paymentDate: Date;
  total: Prisma.Decimal;
  peakLivePaid: Prisma.Decimal;
  amount: string;
  latestVoidedOn: Date | null;
}): {
  documentId: string;
  paymentDate: string;
  conflictingVoidedOn: string;
} | null {
  if (!args.latestVoidedOn) return null;
  const fits = !Money.of(args.total.toString())
    .subtract(Money.of(args.peakLivePaid.toString()))
    .subtract(Money.of(args.amount))
    .isNegative();
  if (fits) return null;
  return {
    documentId: args.documentId,
    paymentDate: args.paymentDate.toISOString().slice(0, 10),
    conflictingVoidedOn: args.latestVoidedOn.toISOString().slice(0, 10),
  };
}

/** Reads, for one document, what backdatedAllocationViolation needs about the
 *  OTHER posted/voided payments allocated to it (a DRAFT — incl. the payment
 *  being posted — is not counted):
 *  - peakLivePaid: max over days D ≥ paymentDate of the aging's as-of paid sum
 *    (same predicate as AgingService). That sum only rises on a payment's
 *    date, so the max is attained at paymentDate or at some later payment
 *    date — those are the only days evaluated;
 *  - latestVoidedOn: the latest voided_on after paymentDate.
 *  Dates are bound as 'YYYY-MM-DD'::date so the session timezone never
 *  shifts the calendar day. Runs under the document FOR UPDATE lock at post
 *  (unwindInTx takes the same lock, so every committed void is seen) and as a
 *  pre-check on the base client at create. */
export async function allocationHistoryAfter(
  db: LedgerTx,
  target: PaymentTarget,
  documentId: string,
  paymentDate: Date,
): Promise<{ peakLivePaid: Prisma.Decimal; latestVoidedOn: Date | null }> {
  const day = paymentDate.toISOString().slice(0, 10);
  const col = Prisma.raw(
    target.table === 'sales_invoices' ? 'sales_invoice_id' : 'purchase_bill_id',
  );
  const rows = await db.$queryRaw<
    { peak_live_paid: string; latest_voided_on: Date | null }[]
  >(Prisma.sql`
    WITH allocs AS (
      SELECT q.date, q.status::text AS status, q.voided_on, pa.amount
      FROM payment_allocations pa
      JOIN payments q ON q.id = pa.payment_id
      WHERE pa.${col} = ${documentId} AND q.deleted_at IS NULL
        AND q.status IN ('POSTED', 'VOID')
    ), days AS (
      SELECT ${day}::date AS day
      UNION SELECT date FROM allocs WHERE date > ${day}::date
    )
    SELECT
      (SELECT COALESCE(MAX(live), 0) FROM (
         SELECT (SELECT COALESCE(SUM(a.amount), 0) FROM allocs a
                 WHERE a.date <= d.day
                   AND (a.status = 'POSTED' OR a.voided_on > d.day)) AS live
         FROM days d) s)::text AS peak_live_paid,
      (SELECT MAX(voided_on) FROM allocs
       WHERE status = 'VOID' AND voided_on > ${day}::date) AS latest_voided_on`);
  return {
    peakLivePaid: new Prisma.Decimal(rows[0].peak_live_paid),
    latestVoidedOn: rows[0].latest_voided_on,
  };
}

/** Throws the 422 when `amount` (this payment's cumulative allocation to the
 *  document so far) would over-allocate it for some past as-of day. */
export async function assertNoBackdatedOverAllocation(
  db: LedgerTx,
  target: PaymentTarget,
  document: { id: string; total: Prisma.Decimal },
  paymentDate: Date,
  amount: string,
): Promise<void> {
  const history = await allocationHistoryAfter(
    db,
    target,
    document.id,
    paymentDate,
  );
  const v = backdatedAllocationViolation({
    documentId: document.id,
    paymentDate,
    total: document.total,
    amount,
    ...history,
  });
  if (v)
    throw new ValidationFailedError(
      'Payment date is inside the live window of a later-voided payment on this document; ' +
        'dated here it would over-allocate the document for past dates. ' +
        'Date it on/after conflictingVoidedOn or lower the amount',
      v,
    );
}

/** The 2-line cash/control journal for a payment. */
export function buildPaymentLines(
  target: PaymentTarget,
  cashAccountId: string,
  controlId: string,
  amount: string,
): PaymentJournalLine[] {
  return target.cashIsDebit
    ? [
        { accountId: cashAccountId, debit: amount },
        { accountId: controlId, credit: amount },
      ]
    : [
        { accountId: controlId, debit: amount },
        { accountId: cashAccountId, credit: amount },
      ];
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Validate the allocation references the right document type, then read it (create-draft path). */
export async function loadTarget(
  client: ExtendedPrismaClient,
  target: PaymentTarget,
  alloc: AllocationInput,
): Promise<TargetRow> {
  const id = target.allocId(alloc);
  if (!id || target.otherId(alloc))
    throw new ValidationFailedError(
      `A ${target.direction.toLowerCase()} allocation must reference a ${target.label}`,
      {},
    );
  const row = await target.find(client, id);
  if (!row)
    throw new NotFoundDomainError(`${cap(target.label)} not found`, { id });
  return row;
}

/** Allocations in ascending target-document id order. Post and void lock each
 *  target FOR UPDATE one by one; taking those locks in one global order means
 *  two payments over the same documents (e.g. [A,B] and [B,A]) queue instead
 *  of deadlocking. Stable, so repeated allocations to one document keep their
 *  relative order. Pure: returns a new array. */
export function inLockOrder(
  target: PaymentTarget,
  allocations: readonly AllocationInput[],
): AllocationInput[] {
  const idOf = (a: AllocationInput) => target.allocId(a) ?? '';
  return [...allocations].sort((a, b) =>
    idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0,
  );
}

/** Lock the target FOR UPDATE, re-verify POSTED + partner + payment date + outstanding
 *  + the backdated-void rule, increment amountPaid. Call once per allocation so repeated
 *  allocations to one document see each other's increment under the lock;
 *  `settledBefore` is what THIS payment already allocated to the same document
 *  in earlier calls (the payment is still a DRAFT, so the history read does not
 *  count it). */
export async function settleInTx(
  tx: LedgerTx,
  target: PaymentTarget,
  alloc: AllocationInput,
  partnerId: string,
  paymentDate: Date,
  settledBefore: Money = Money.zero(),
): Promise<void> {
  const id = target.allocId(alloc)!;
  const rows = await tx.$queryRaw<
    {
      status: string;
      total: string;
      amount_paid: string;
      partner_id: string;
      date: Date;
    }[]
  >(
    Prisma.sql`SELECT status, total, amount_paid, partner_id, date FROM ${Prisma.raw(target.table)} WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`,
  );
  if (rows.length === 0 || rows[0].status !== 'POSTED')
    throw new ValidationFailedError(`Allocated ${target.noun} is not posted`, {
      id,
    });
  if (rows[0].partner_id !== partnerId)
    throw new ValidationFailedError(
      `Allocated ${target.noun} belongs to another partner`,
      { id },
    );
  assertPaymentDateNotBefore(paymentDate, { id, date: rows[0].date });
  if (
    exceedsOutstanding(
      new Prisma.Decimal(rows[0].total),
      new Prisma.Decimal(rows[0].amount_paid),
      alloc.amount,
    )
  )
    throw new ConflictDomainError('Allocation now exceeds outstanding', { id });
  await assertNoBackdatedOverAllocation(
    tx,
    target,
    { id, total: new Prisma.Decimal(rows[0].total) },
    paymentDate,
    settledBefore.add(Money.of(alloc.amount)).toPersistence(),
  );
  await target.applyPaid(tx, id, new Prisma.Decimal(alloc.amount), 1);
}

/** Lock the target FOR UPDATE, floor-check, decrement amountPaid (void path). */
export async function unwindInTx(
  tx: LedgerTx,
  target: PaymentTarget,
  alloc: AllocationInput,
): Promise<void> {
  const id = target.allocId(alloc)!;
  const rows = await tx.$queryRaw<{ amount_paid: string }[]>(
    Prisma.sql`SELECT amount_paid FROM ${Prisma.raw(target.table)} WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`,
  );
  if (
    rows.length === 0 ||
    Money.of(rows[0].amount_paid).subtract(Money.of(alloc.amount)).isNegative()
  )
    throw new ConflictDomainError('Void would drive amountPaid negative', {
      id,
    });
  await target.applyPaid(tx, id, new Prisma.Decimal(alloc.amount), -1);
}
