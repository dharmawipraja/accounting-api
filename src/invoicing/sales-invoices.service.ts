import { Injectable } from '@nestjs/common';
import { Prisma, SalesInvoice } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import { PostingService } from '../ledger/posting/posting.service';
import {
  ConflictDomainError,
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';
import { BusinessPartnersService } from './business-partners.service';
import { DocumentPostingService } from './document-posting.service';

const AR_CONTROL_CODE = '1-1200';

export interface InvoiceLineInput {
  description: string;
  accountId: string;
  quantity: string;
  unitPrice: string;
  taxCodeIds: string[];
}
export interface CreateInvoiceInput {
  partnerId: string;
  date: Date;
  dueDate?: Date;
  description?: string;
  lines: InvoiceLineInput[];
  createdBy: string;
}
export interface UpdateInvoiceInput {
  date?: Date;
  dueDate?: Date;
  description?: string;
  lines?: InvoiceLineInput[];
}

@Injectable()
export class SalesInvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly partners: BusinessPartnersService,
    private readonly docPosting: DocumentPostingService,
    private readonly posting: PostingService,
  ) {}

  private async arControlId(): Promise<string> {
    const acc = await this.prisma.client.account.findFirst({
      where: { code: AR_CONTROL_CODE },
    });
    if (!acc)
      throw new ValidationFailedError('AR control account missing from chart', {
        code: AR_CONTROL_CODE,
      });
    return acc.id;
  }

  private taxableLines(
    lines: {
      accountId: string;
      quantity: Prisma.Decimal | string;
      unitPrice: Prisma.Decimal | string;
      taxCodeIds: string[];
    }[],
  ) {
    return lines.map((l) => ({
      accountId: l.accountId,
      amount: Money.of(l.unitPrice.toString())
        .multiply(l.quantity.toString())
        .toPersistence(),
      taxCodeIds: l.taxCodeIds,
    }));
  }

  async createDraft(input: CreateInvoiceInput): Promise<SalesInvoice> {
    const partner = await this.partners.findById(input.partnerId);
    if (!partner.isCustomer || !partner.isActive) {
      throw new ValidationFailedError('Partner is not an active customer', {
        partnerId: input.partnerId,
      });
    }
    const settlementId = await this.arControlId();
    const totals = await this.docPosting.computeTotals(
      'SALE',
      settlementId,
      this.taxableLines(input.lines),
    );
    return this.prisma.client.salesInvoice.create({
      data: {
        partnerId: input.partnerId,
        date: input.date,
        dueDate: input.dueDate,
        description: input.description,
        subtotal: totals.subtotal,
        taxTotal: totals.taxTotal,
        withholdingTotal: totals.withholdingTotal,
        total: totals.total,
        createdBy: input.createdBy,
        lines: {
          create: input.lines.map((l, i) => ({
            lineNo: i + 1,
            description: l.description,
            accountId: l.accountId,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            amount: Money.of(l.unitPrice).multiply(l.quantity).toPersistence(),
            taxCodeIds: l.taxCodeIds,
          })),
        },
      },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
  }

  async update(id: string, input: UpdateInvoiceInput): Promise<SalesInvoice> {
    const inv = await this.getById(id);
    if (inv.status !== 'DRAFT') {
      throw new ValidationFailedError('Only a DRAFT invoice can be edited', {
        id,
        status: inv.status,
      });
    }
    const existing = inv as SalesInvoice & {
      lines: {
        description: string;
        accountId: string;
        quantity: Prisma.Decimal;
        unitPrice: Prisma.Decimal;
        taxCodeIds: string[];
      }[];
    };
    const nextLines: InvoiceLineInput[] = input.lines
      ? input.lines
      : existing.lines.map((l) => ({
          description: l.description,
          accountId: l.accountId,
          quantity: l.quantity.toString(),
          unitPrice: l.unitPrice.toString(),
          taxCodeIds: l.taxCodeIds,
        }));
    const settlementId = await this.arControlId();
    const totals = await this.docPosting.computeTotals(
      'SALE',
      settlementId,
      this.taxableLines(nextLines),
    );
    await this.prisma.client.$transaction(async (tx) => {
      await tx.salesInvoiceLine.deleteMany({ where: { salesInvoiceId: id } });
      await tx.salesInvoice.update({
        where: { id },
        data: {
          date: input.date ?? inv.date,
          dueDate: input.dueDate ?? inv.dueDate,
          description: input.description ?? inv.description,
          subtotal: totals.subtotal,
          taxTotal: totals.taxTotal,
          withholdingTotal: totals.withholdingTotal,
          total: totals.total,
          lines: {
            create: nextLines.map((l, i) => ({
              lineNo: i + 1,
              description: l.description,
              accountId: l.accountId,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              amount: Money.of(l.unitPrice)
                .multiply(l.quantity)
                .toPersistence(),
              taxCodeIds: l.taxCodeIds,
            })),
          },
        },
      });
    });
    return this.getById(id);
  }

  async getById(id: string): Promise<SalesInvoice> {
    const inv = await this.prisma.client.salesInvoice.findFirst({
      where: { id },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (!inv) throw new NotFoundDomainError('Sales invoice not found', { id });
    return inv;
  }

  async list(filter: {
    partnerId?: string;
    status?: string;
  }): Promise<SalesInvoice[]> {
    return this.prisma.client.salesInvoice.findMany({
      where: { partnerId: filter.partnerId, status: filter.status as never },
      orderBy: { createdAt: 'desc' },
    });
  }

  async deleteDraft(id: string, deletedBy: string): Promise<void> {
    const inv = await this.getById(id);
    if (inv.status !== 'DRAFT') {
      throw new ValidationFailedError('Only a DRAFT invoice can be deleted', {
        id,
        status: inv.status,
      });
    }
    const res = await this.prisma.client.salesInvoice.updateMany({
      where: { id, status: 'DRAFT', deletedAt: null },
      data: { deletedAt: new Date(), deletedBy },
    });
    if (res.count !== 1)
      throw new ValidationFailedError('Only a DRAFT invoice can be deleted', {
        id,
      });
  }

  async post(id: string, postedBy: string): Promise<SalesInvoice> {
    const inv = await this.getById(id);
    if (inv.status !== 'DRAFT') {
      throw new ValidationFailedError('Invoice is not a draft', {
        id,
        status: inv.status,
      });
    }
    const partner = await this.partners.findById(inv.partnerId);
    if (!partner.isCustomer || !partner.isActive) {
      throw new ValidationFailedError('Partner is not an active customer', {
        partnerId: inv.partnerId,
      });
    }
    const settlementId = await this.arControlId();
    const lines = (
      inv as SalesInvoice & {
        lines: {
          accountId: string;
          quantity: Prisma.Decimal;
          unitPrice: Prisma.Decimal;
          taxCodeIds: string[];
        }[];
      }
    ).lines;

    await this.docPosting.post(
      {
        nature: 'SALE',
        settlementAccountId: settlementId,
        date: inv.date,
        description: inv.description ?? `Sales invoice ${id}`,
        sourceType: 'SALES_INVOICE',
        sourceId: id,
        createdBy: inv.createdBy,
        postedBy,
        documentType: 'INV',
        lines: this.taxableLines(lines),
      },
      async (tx) => {
        const locked = await tx.$queryRaw<{ status: string }[]>`
          SELECT status FROM sales_invoices WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
        if (locked.length === 0 || locked[0].status !== 'DRAFT') {
          throw new ValidationFailedError('Invoice is no longer a draft', {
            id,
          });
        }
      },
      async ({ tx, number, ref, entry, fiscalYear }) => {
        const totals = await this.docPosting.computeTotals(
          'SALE',
          settlementId,
          this.taxableLines(lines),
        );
        await tx.salesInvoice.update({
          where: { id },
          data: {
            status: 'POSTED',
            invoiceNumber: number,
            invoiceRef: ref,
            fiscalYear,
            journalEntryId: entry.id,
            postedBy,
            postedAt: new Date(),
            subtotal: totals.subtotal,
            taxTotal: totals.taxTotal,
            withholdingTotal: totals.withholdingTotal,
            total: totals.total,
          },
        });
      },
    );
    return this.getById(id);
  }

  async void(id: string, voidedBy: string): Promise<SalesInvoice> {
    const inv = await this.getById(id);
    if (inv.status !== 'POSTED') {
      throw new ValidationFailedError('Only a POSTED invoice can be voided', {
        id,
        status: inv.status,
      });
    }
    if (!Money.of(inv.amountPaid.toString()).isZero()) {
      throw new ConflictDomainError(
        'Cannot void an invoice with payments; void the payments first',
        { id },
      );
    }
    const { original, periodId, fiscalYear, reversalDate } =
      await this.posting.prepareReversal(inv.journalEntryId!);
    try {
      await this.prisma.client.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<
          { status: string; amount_paid: string }[]
        >`
          SELECT status, amount_paid FROM sales_invoices WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
        if (locked.length === 0 || locked[0].status !== 'POSTED') {
          throw new ValidationFailedError('Invoice is not posted', { id });
        }
        if (Number(locked[0].amount_paid) !== 0) {
          throw new ConflictDomainError(
            'Cannot void an invoice with payments',
            { id },
          );
        }
        await this.posting.reverseInTx(
          tx,
          original,
          voidedBy,
          periodId,
          fiscalYear,
          reversalDate,
        );
        await tx.salesInvoice.update({
          where: { id },
          data: { status: 'VOID' },
        });
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ValidationFailedError(
          'Invoice journal entry was already reversed',
          { id },
        );
      }
      throw err;
    }
    return this.getById(id);
  }

  /** Shape the API response with derived outstanding + paymentStatus. Money
   *  columns are normalized to 4dp strings (matching the ledger serialization
   *  convention) since Prisma's Decimal#toJSON strips trailing zeros. */
  present(
    inv: SalesInvoice,
  ): SalesInvoice & { outstanding: string; paymentStatus: string } {
    const total = Money.of(inv.total.toString());
    const paid = Money.of(inv.amountPaid.toString());
    const outstanding = total.subtract(paid);
    const paymentStatus = paid.isZero()
      ? 'UNPAID'
      : outstanding.isZero() || outstanding.isNegative()
        ? 'PAID'
        : 'PARTIAL';
    return {
      ...inv,
      subtotal: inv.subtotal.toFixed(4) as unknown as SalesInvoice['subtotal'],
      taxTotal: inv.taxTotal.toFixed(4) as unknown as SalesInvoice['taxTotal'],
      withholdingTotal: inv.withholdingTotal.toFixed(
        4,
      ) as unknown as SalesInvoice['withholdingTotal'],
      total: inv.total.toFixed(4) as unknown as SalesInvoice['total'],
      amountPaid: inv.amountPaid.toFixed(
        4,
      ) as unknown as SalesInvoice['amountPaid'],
      outstanding: outstanding.toPersistence(),
      paymentStatus,
    };
  }
}
