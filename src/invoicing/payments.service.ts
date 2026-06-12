import { Injectable } from '@nestjs/common';
import {
  DocumentStatus,
  Payment,
  PaymentDirection,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import { PostingService } from '../ledger/posting/posting.service';
import {
  ConflictDomainError,
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';
import { BusinessPartnersService } from './business-partners.service';
import { DocumentNumberService } from './document-number.service';

const AR_CONTROL_CODE = '1-1200';
const AP_CONTROL_CODE = '2-1000';

export interface AllocationInput {
  salesInvoiceId?: string;
  purchaseBillId?: string;
  amount: string;
}
export interface CreatePaymentInput {
  direction: PaymentDirection;
  partnerId: string;
  date: Date;
  cashAccountId: string;
  description?: string;
  allocations: AllocationInput[];
  createdBy: string;
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly partners: BusinessPartnersService,
    private readonly posting: PostingService,
    private readonly docNumber: DocumentNumberService,
  ) {}

  private async controlId(code: string): Promise<string> {
    const a = await this.prisma.client.account.findFirst({ where: { code } });
    if (!a)
      throw new ValidationFailedError('Control account missing from chart', {
        code,
      });
    return a.id;
  }

  /** Load the target document (sales invoice for RECEIPT, purchase bill for DISBURSEMENT). */
  private async loadTarget(
    direction: PaymentDirection,
    alloc: AllocationInput,
  ) {
    if (direction === 'RECEIPT') {
      if (!alloc.salesInvoiceId || alloc.purchaseBillId)
        throw new ValidationFailedError(
          'A receipt allocation must reference a sales invoice',
          {},
        );
      const inv = await this.prisma.client.salesInvoice.findFirst({
        where: { id: alloc.salesInvoiceId },
      });
      if (!inv)
        throw new NotFoundDomainError('Sales invoice not found', {
          id: alloc.salesInvoiceId,
        });
      return {
        id: inv.id,
        partnerId: inv.partnerId,
        status: inv.status,
        total: inv.total,
        amountPaid: inv.amountPaid,
      };
    }
    if (!alloc.purchaseBillId || alloc.salesInvoiceId)
      throw new ValidationFailedError(
        'A disbursement allocation must reference a purchase bill',
        {},
      );
    const bill = await this.prisma.client.purchaseBill.findFirst({
      where: { id: alloc.purchaseBillId },
    });
    if (!bill)
      throw new NotFoundDomainError('Purchase bill not found', {
        id: alloc.purchaseBillId,
      });
    return {
      id: bill.id,
      partnerId: bill.partnerId,
      status: bill.status,
      total: bill.total,
      amountPaid: bill.amountPaid,
    };
  }

  async createDraft(input: CreatePaymentInput): Promise<Payment> {
    if (input.allocations.length === 0)
      throw new ValidationFailedError(
        'A payment needs at least one allocation',
        {},
      );
    const partner = await this.partners.findById(input.partnerId);
    if (!partner.isActive)
      throw new ValidationFailedError('Partner is inactive', {
        partnerId: input.partnerId,
      });
    if (input.direction === 'RECEIPT' && !partner.isCustomer)
      throw new ValidationFailedError('Receipt requires a customer', {
        partnerId: input.partnerId,
      });
    if (input.direction === 'DISBURSEMENT' && !partner.isVendor)
      throw new ValidationFailedError('Disbursement requires a vendor', {
        partnerId: input.partnerId,
      });
    const cash = await this.prisma.client.account.findFirst({
      where: { id: input.cashAccountId },
    });
    if (!cash || !cash.isPostable || !cash.isActive)
      throw new ValidationFailedError('Cash account is not postable', {
        cashAccountId: input.cashAccountId,
      });

    let total = Money.zero();
    for (const alloc of input.allocations) {
      const amt = Money.of(alloc.amount);
      if (amt.isZero() || amt.isNegative())
        throw new ValidationFailedError(
          'Allocation amount must be positive',
          {},
        );
      const target = await this.loadTarget(input.direction, alloc);
      if (target.partnerId !== input.partnerId)
        throw new ValidationFailedError(
          'Allocated document belongs to another partner',
          { documentId: target.id },
        );
      if (target.status !== 'POSTED')
        throw new ValidationFailedError(
          'Can only allocate to a POSTED document',
          { documentId: target.id, status: target.status },
        );
      const outstanding = Money.of(target.total.toString()).subtract(
        Money.of(target.amountPaid.toString()),
      );
      // amt > outstanding  ⟺  (outstanding − amt) < 0
      if (outstanding.subtract(amt).isNegative()) {
        throw new ValidationFailedError(
          'Allocation exceeds the document outstanding',
          { documentId: target.id },
        );
      }
      total = total.add(amt);
    }

    return this.prisma.client.payment.create({
      data: {
        direction: input.direction,
        partnerId: input.partnerId,
        date: input.date,
        cashAccountId: input.cashAccountId,
        amount: total.toPersistence(),
        description: input.description,
        createdBy: input.createdBy,
        allocations: {
          create: input.allocations.map((a) => ({
            salesInvoiceId: a.salesInvoiceId,
            purchaseBillId: a.purchaseBillId,
            amount: a.amount,
          })),
        },
      },
      include: { allocations: true },
    });
  }

  async getById(id: string): Promise<Payment> {
    const p = await this.prisma.client.payment.findFirst({
      where: { id },
      include: { allocations: true },
    });
    if (!p) throw new NotFoundDomainError('Payment not found', { id });
    return p;
  }

  async list(filter: {
    partnerId?: string;
    direction?: PaymentDirection;
    status?: DocumentStatus;
  }): Promise<Payment[]> {
    return this.prisma.client.payment.findMany({
      where: {
        partnerId: filter.partnerId,
        direction: filter.direction,
        status: filter.status,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteDraft(id: string, deletedBy: string): Promise<void> {
    const p = await this.getById(id);
    if (p.status !== 'DRAFT')
      throw new ValidationFailedError('Only a DRAFT payment can be deleted', {
        id,
        status: p.status,
      });
    const res = await this.prisma.client.payment.updateMany({
      where: { id, status: 'DRAFT', deletedAt: null },
      data: { deletedAt: new Date(), deletedBy },
    });
    if (res.count !== 1)
      throw new ValidationFailedError('Only a DRAFT payment can be deleted', {
        id,
      });
  }

  async post(id: string, postedBy: string): Promise<Payment> {
    const payment = await this.getById(id);
    if (payment.status !== 'DRAFT')
      throw new ValidationFailedError('Payment is not a draft', {
        id,
        status: payment.status,
      });
    const allocations = (
      payment as Payment & {
        allocations: {
          salesInvoiceId: string | null;
          purchaseBillId: string | null;
          amount: Prisma.Decimal;
        }[];
      }
    ).allocations;
    const isReceipt = payment.direction === 'RECEIPT';
    const controlId = await this.controlId(
      isReceipt ? AR_CONTROL_CODE : AP_CONTROL_CODE,
    );
    const amount = Money.of(payment.amount.toString());

    // Build the 2-line journal: RECEIPT Dr cash / Cr AR ; DISBURSEMENT Dr AP / Cr cash.
    const journalInput = {
      date: payment.date,
      description: payment.description ?? `Payment ${id}`,
      sourceType: 'PAYMENT' as const,
      sourceId: id,
      createdBy: payment.createdBy,
      lines: isReceipt
        ? [
            { accountId: payment.cashAccountId, debit: amount.toPersistence() },
            { accountId: controlId, credit: amount.toPersistence() },
          ]
        : [
            { accountId: controlId, debit: amount.toPersistence() },
            {
              accountId: payment.cashAccountId,
              credit: amount.toPersistence(),
            },
          ],
    };
    const { periodId, fiscalYear } = await this.posting.preparePosting(
      journalInput,
      postedBy,
    );

    await this.prisma.client.$transaction(
      async (tx) => {
        // Lock + re-check the payment is still a draft.
        const lockedP = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM payments WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
        if (lockedP.length === 0 || lockedP[0].status !== 'DRAFT')
          throw new ValidationFailedError('Payment is no longer a draft', {
            id,
          });

        // Lock each target document FOR UPDATE and re-verify outstanding (the real over-allocation guard).
        for (const a of allocations) {
          const amt = Money.of(a.amount.toString());
          if (isReceipt) {
            const rows = await tx.$queryRaw<
              { status: string; total: string; amount_paid: string }[]
            >`
            SELECT status, total, amount_paid FROM sales_invoices WHERE id = ${a.salesInvoiceId} AND deleted_at IS NULL FOR UPDATE`;
            if (rows.length === 0 || rows[0].status !== 'POSTED')
              throw new ValidationFailedError(
                'Allocated invoice is not posted',
                {
                  id: a.salesInvoiceId,
                },
              );
            const outstanding = Money.of(rows[0].total).subtract(
              Money.of(rows[0].amount_paid),
            );
            if (outstanding.subtract(amt).isNegative())
              throw new ConflictDomainError(
                'Allocation now exceeds outstanding',
                {
                  id: a.salesInvoiceId,
                },
              );
            await tx.salesInvoice.update({
              where: { id: a.salesInvoiceId! },
              data: { amountPaid: { increment: a.amount } },
            });
          } else {
            const rows = await tx.$queryRaw<
              { status: string; total: string; amount_paid: string }[]
            >`
            SELECT status, total, amount_paid FROM purchase_bills WHERE id = ${a.purchaseBillId} AND deleted_at IS NULL FOR UPDATE`;
            if (rows.length === 0 || rows[0].status !== 'POSTED')
              throw new ValidationFailedError('Allocated bill is not posted', {
                id: a.purchaseBillId,
              });
            const outstanding = Money.of(rows[0].total).subtract(
              Money.of(rows[0].amount_paid),
            );
            if (outstanding.subtract(amt).isNegative())
              throw new ConflictDomainError(
                'Allocation now exceeds outstanding',
                {
                  id: a.purchaseBillId,
                },
              );
            await tx.purchaseBill.update({
              where: { id: a.purchaseBillId! },
              data: { amountPaid: { increment: a.amount } },
            });
          }
        }

        const number = await this.docNumber.next(
          tx,
          isReceipt ? 'PAY-RCV' : 'PAY-DSB',
          fiscalYear,
        );
        const ref = this.docNumber.buildRef(
          isReceipt ? 'PAY-RCV' : 'PAY-DSB',
          fiscalYear,
          number,
        );
        const entry = await this.posting.createPostedEntryInTx(
          tx,
          journalInput,
          postedBy,
          periodId,
          fiscalYear,
        );
        await tx.payment.update({
          where: { id },
          data: {
            status: 'POSTED',
            number,
            ref,
            fiscalYear,
            journalEntryId: entry.id,
            postedBy,
            postedAt: new Date(),
          },
        });
        // A concurrent post of the same invoice blocks here on the FOR UPDATE locks
        // above. Give it room to wait out the winner and reach its clean 409 instead
        // of hitting Prisma's 5s default and surfacing as a 500 under load.
      },
      {
        maxWait: 5000,
        timeout: 20000,
      },
    );
    return this.getById(id);
  }

  async void(id: string, voidedBy: string): Promise<Payment> {
    const payment = await this.getById(id);
    if (payment.status !== 'POSTED')
      throw new ValidationFailedError('Only a POSTED payment can be voided', {
        id,
        status: payment.status,
      });
    const allocations = (
      payment as Payment & {
        allocations: {
          salesInvoiceId: string | null;
          purchaseBillId: string | null;
          amount: Prisma.Decimal;
        }[];
      }
    ).allocations;
    const { original, periodId, fiscalYear, reversalDate } =
      await this.posting.prepareReversal(payment.journalEntryId!);
    try {
      await this.prisma.client.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ status: string }[]>`
          SELECT status FROM payments WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
        if (locked.length === 0 || locked[0].status !== 'POSTED')
          throw new ValidationFailedError('Payment is not posted', { id });
        for (const a of allocations) {
          if (a.salesInvoiceId)
            await tx.salesInvoice.update({
              where: { id: a.salesInvoiceId },
              data: { amountPaid: { decrement: a.amount } },
            });
          if (a.purchaseBillId)
            await tx.purchaseBill.update({
              where: { id: a.purchaseBillId },
              data: { amountPaid: { decrement: a.amount } },
            });
        }
        await this.posting.reverseInTx(
          tx,
          original,
          voidedBy,
          periodId,
          fiscalYear,
          reversalDate,
        );
        await tx.payment.update({
          where: { id },
          data: { status: 'VOID' },
        });
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      )
        throw new ValidationFailedError(
          'Payment journal entry was already reversed',
          { id },
        );
      throw err;
    }
    return this.getById(id);
  }

  /** Shape the API response. Money columns are normalized to 4dp strings (matching
   *  the ledger/invoice serialization convention) since Prisma's Decimal#toJSON
   *  strips trailing zeros. */
  present(payment: Payment): Payment {
    const allocations = (
      payment as Payment & {
        allocations?: { amount: Prisma.Decimal }[];
      }
    ).allocations;
    return {
      ...payment,
      amount: payment.amount.toFixed(4) as unknown as Payment['amount'],
      ...(allocations
        ? {
            allocations: allocations.map((a) => ({
              ...a,
              amount: a.amount.toFixed(4),
            })),
          }
        : {}),
    };
  }
}
