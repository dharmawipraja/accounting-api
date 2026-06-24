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

/** Lock the target FOR UPDATE, re-verify POSTED + partner + outstanding, increment amountPaid.
 *  Call once per allocation so repeated allocations to one document see each other's
 *  increment under the lock. */
export async function settleInTx(
  tx: LedgerTx,
  target: PaymentTarget,
  alloc: AllocationInput,
  partnerId: string,
): Promise<void> {
  const id = target.allocId(alloc)!;
  const rows = await tx.$queryRaw<
    {
      status: string;
      total: string;
      amount_paid: string;
      partner_id: string;
    }[]
  >(
    Prisma.sql`SELECT status, total, amount_paid, partner_id FROM ${Prisma.raw(target.table)} WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`,
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
  if (
    exceedsOutstanding(
      new Prisma.Decimal(rows[0].total),
      new Prisma.Decimal(rows[0].amount_paid),
      alloc.amount,
    )
  )
    throw new ConflictDomainError('Allocation now exceeds outstanding', { id });
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
