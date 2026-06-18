import { Injectable } from '@nestjs/common';
import { DocumentStatus, Prisma, SalesInvoice } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import {
  ConflictDomainError,
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';
import { BusinessPartnersService } from './business-partners.service';
import { DocumentPostingService } from './document-posting.service';
import {
  trigramSearch,
} from '../common/search/trigram-search';
import { listPaginated } from '../common/pagination/paginated';
import { serializeMoney } from '../common/money/serialize-money';
import { taxableLines, findControlAccountId, AR_CONTROL_CODE } from './document-helpers';
import { DocumentLifecycleService } from '../ledger/document-lifecycle.service';

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
    private readonly lifecycle: DocumentLifecycleService,
  ) {}

  async createDraft(input: CreateInvoiceInput): Promise<SalesInvoice> {
    const partner = await this.partners.findById(input.partnerId);
    if (!partner.isCustomer || !partner.isActive) {
      throw new ValidationFailedError('Partner is not an active customer', {
        partnerId: input.partnerId,
      });
    }
    const settlementId = await findControlAccountId(this.prisma, AR_CONTROL_CODE);
    const totals = await this.docPosting.computeTotals(
      'SALE',
      settlementId,
      taxableLines(input.lines),
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
    const settlementId = await findControlAccountId(this.prisma, AR_CONTROL_CODE);
    const totals = await this.docPosting.computeTotals(
      'SALE',
      settlementId,
      taxableLines(nextLines),
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

  async listPage(q: {
    q?: string;
    partnerId?: string;
    status?: DocumentStatus;
    limit?: number;
    offset?: number;
  }) {
    const filters: Prisma.Sql[] = [];
    if (q.partnerId) filters.push(Prisma.sql`t.partner_id = ${q.partnerId}`);
    if (q.status) filters.push(Prisma.sql`t.status::text = ${q.status}`);
    const where = { partnerId: q.partnerId, status: q.status };
    return listPaginated({
      q: q.q,
      limit: q.limit,
      offset: q.offset,
      present: (r: SalesInvoice) => this.present(r),
      search: ({ term, limit, offset }) =>
        trigramSearch(this.prisma, {
          table: 'sales_invoices',
          alias: 't',
          ownColumns: ['invoice_ref', 'description'],
          join: { table: 'business_partners', alias: 'p', onColumn: 'partner_id', columns: ['name'] },
          filters,
          q: term,
          limit,
          offset,
        }),
      hydrate: (ids) => this.prisma.client.salesInvoice.findMany({ where: { id: { in: ids } } }),
      page: async ({ limit, offset }) => {
        const [rows, total] = await Promise.all([
          this.prisma.client.salesInvoice.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, skip: offset }),
          this.prisma.client.salesInvoice.count({ where }),
        ]);
        return { rows, total };
      },
    });
  }

  async deleteDraft(id: string, deletedBy: string): Promise<void> {
    return this.lifecycle.softDeleteDraft(this.prisma.client.salesInvoice, id, deletedBy, 'invoice');
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
    const settlementId = await findControlAccountId(this.prisma, AR_CONTROL_CODE);
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
        lines: taxableLines(lines),
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
      async ({ tx, number, ref, entry, fiscalYear, totals }) => {
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
    await this.lifecycle.reverseWithGuard({
      id,
      journalEntryId: inv.journalEntryId!,
      reversedBy: voidedBy,
      alreadyReversedMessage: 'Invoice journal entry was already reversed',
      notPostedMessage: 'Invoice is not posted',
      lock: async (tx) => {
        const rows = await tx.$queryRaw<{ status: string; amount_paid: string }[]>`
          SELECT status, amount_paid FROM sales_invoices WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
        return rows[0];
      },
      applyInTx: async (tx, locked) => {
        if (Number(locked.amount_paid) !== 0) {
          throw new ConflictDomainError(
            'Cannot void an invoice with payments',
            { id },
          );
        }
        await tx.salesInvoice.update({
          where: { id },
          data: { status: 'VOID' },
        });
      },
    });
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
    const lines = (inv as SalesInvoice & { lines?: Record<string, unknown>[] }).lines;
    return {
      ...serializeMoney(inv, ['subtotal', 'taxTotal', 'withholdingTotal', 'total', 'amountPaid']),
      ...(lines
        ? { lines: lines.map((l) => serializeMoney(l, ['quantity', 'unitPrice', 'amount'])) }
        : {}),
      outstanding: outstanding.toPersistence(),
      paymentStatus,
    } as SalesInvoice & { outstanding: string; paymentStatus: string };
  }
}
