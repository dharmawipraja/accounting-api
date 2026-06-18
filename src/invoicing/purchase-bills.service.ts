import { Injectable } from '@nestjs/common';
import { DocumentStatus, Prisma, PurchaseBill } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import {
  ConflictDomainError,
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';
import { BusinessPartnersService } from './business-partners.service';
import { DocumentPostingService } from './document-posting.service';
import { trigramSearch } from '../common/search/trigram-search';
import { listPaginated } from '../common/pagination/paginated';
import { serializeMoney } from '../common/money/serialize-money';
import {
  taxableLines,
  findControlAccountId,
  AP_CONTROL_CODE,
} from './document-helpers';
import { DocumentLifecycleService } from '../ledger/document-lifecycle.service';

export interface BillLineInput {
  description: string;
  accountId: string;
  quantity: string;
  unitPrice: string;
  taxCodeIds: string[];
}
export interface CreateBillInput {
  partnerId: string;
  vendorInvoiceNo?: string;
  date: Date;
  dueDate?: Date;
  description?: string;
  lines: BillLineInput[];
  createdBy: string;
}
export interface UpdateBillInput {
  vendorInvoiceNo?: string;
  date?: Date;
  dueDate?: Date;
  description?: string;
  lines?: BillLineInput[];
}

@Injectable()
export class PurchaseBillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly partners: BusinessPartnersService,
    private readonly docPosting: DocumentPostingService,
    private readonly lifecycle: DocumentLifecycleService,
  ) {}

  async createDraft(input: CreateBillInput): Promise<PurchaseBill> {
    const partner = await this.partners.findById(input.partnerId);
    if (!partner.isVendor || !partner.isActive) {
      throw new ValidationFailedError('Partner is not an active vendor', {
        partnerId: input.partnerId,
      });
    }
    const settlementId = await findControlAccountId(
      this.prisma,
      AP_CONTROL_CODE,
    );
    const totals = await this.docPosting.computeTotals(
      'PURCHASE',
      settlementId,
      taxableLines(input.lines),
    );
    return this.prisma.client.purchaseBill.create({
      data: {
        partnerId: input.partnerId,
        vendorInvoiceNo: input.vendorInvoiceNo,
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

  async update(id: string, input: UpdateBillInput): Promise<PurchaseBill> {
    const bill = await this.getById(id);
    if (bill.status !== 'DRAFT') {
      throw new ValidationFailedError('Only a DRAFT bill can be edited', {
        id,
        status: bill.status,
      });
    }
    const existing = bill as PurchaseBill & {
      lines: {
        description: string;
        accountId: string;
        quantity: Prisma.Decimal;
        unitPrice: Prisma.Decimal;
        taxCodeIds: string[];
      }[];
    };
    const nextLines: BillLineInput[] = input.lines
      ? input.lines
      : existing.lines.map((l) => ({
          description: l.description,
          accountId: l.accountId,
          quantity: l.quantity.toString(),
          unitPrice: l.unitPrice.toString(),
          taxCodeIds: l.taxCodeIds,
        }));
    const settlementId = await findControlAccountId(
      this.prisma,
      AP_CONTROL_CODE,
    );
    const totals = await this.docPosting.computeTotals(
      'PURCHASE',
      settlementId,
      taxableLines(nextLines),
    );
    await this.prisma.client.$transaction(async (tx) => {
      await tx.purchaseBillLine.deleteMany({ where: { purchaseBillId: id } });
      await tx.purchaseBill.update({
        where: { id },
        data: {
          vendorInvoiceNo: input.vendorInvoiceNo ?? bill.vendorInvoiceNo,
          date: input.date ?? bill.date,
          dueDate: input.dueDate ?? bill.dueDate,
          description: input.description ?? bill.description,
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

  async getById(id: string): Promise<PurchaseBill> {
    const bill = await this.prisma.client.purchaseBill.findFirst({
      where: { id },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (!bill) throw new NotFoundDomainError('Purchase bill not found', { id });
    return bill;
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
      present: (r: PurchaseBill) => this.present(r),
      search: ({ term, limit, offset }) =>
        trigramSearch(this.prisma, {
          table: 'purchase_bills',
          alias: 't',
          ownColumns: ['bill_ref', 'vendor_invoice_no', 'description'],
          join: {
            table: 'business_partners',
            alias: 'p',
            onColumn: 'partner_id',
            columns: ['name'],
          },
          filters,
          q: term,
          limit,
          offset,
        }),
      hydrate: (ids) =>
        this.prisma.client.purchaseBill.findMany({
          where: { id: { in: ids } },
        }),
      page: async ({ limit, offset }) => {
        const [rows, total] = await Promise.all([
          this.prisma.client.purchaseBill.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: limit,
            skip: offset,
          }),
          this.prisma.client.purchaseBill.count({ where }),
        ]);
        return { rows, total };
      },
    });
  }

  async deleteDraft(id: string, deletedBy: string): Promise<void> {
    return this.lifecycle.softDeleteDraft(
      this.prisma.client.purchaseBill,
      id,
      deletedBy,
      'bill',
    );
  }

  async post(id: string, postedBy: string): Promise<PurchaseBill> {
    const bill = await this.getById(id);
    if (bill.status !== 'DRAFT') {
      throw new ValidationFailedError('Bill is not a draft', {
        id,
        status: bill.status,
      });
    }
    const partner = await this.partners.findById(bill.partnerId);
    if (!partner.isVendor || !partner.isActive) {
      throw new ValidationFailedError('Partner is not an active vendor', {
        partnerId: bill.partnerId,
      });
    }
    const settlementId = await findControlAccountId(
      this.prisma,
      AP_CONTROL_CODE,
    );
    const lines = (
      bill as PurchaseBill & {
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
        nature: 'PURCHASE',
        settlementAccountId: settlementId,
        date: bill.date,
        description: bill.description ?? `Purchase bill ${id}`,
        sourceType: 'PURCHASE_BILL',
        sourceId: id,
        createdBy: bill.createdBy,
        postedBy,
        documentType: 'BILL',
        lines: taxableLines(lines),
      },
      async (tx) => {
        const locked = await tx.$queryRaw<{ status: string }[]>`
          SELECT status FROM purchase_bills WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
        if (locked.length === 0 || locked[0].status !== 'DRAFT') {
          throw new ValidationFailedError('Bill is no longer a draft', {
            id,
          });
        }
      },
      async ({ tx, number, ref, entry, fiscalYear, totals }) => {
        await tx.purchaseBill.update({
          where: { id },
          data: {
            status: 'POSTED',
            billNumber: number,
            billRef: ref,
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

  async void(id: string, voidedBy: string): Promise<PurchaseBill> {
    const bill = await this.getById(id);
    if (bill.status !== 'POSTED') {
      throw new ValidationFailedError('Only a POSTED bill can be voided', {
        id,
        status: bill.status,
      });
    }
    if (!Money.of(bill.amountPaid.toString()).isZero()) {
      throw new ConflictDomainError(
        'Cannot void a bill with payments; void the payments first',
        { id },
      );
    }
    await this.lifecycle.reverseWithGuard({
      id,
      journalEntryId: bill.journalEntryId!,
      reversedBy: voidedBy,
      alreadyReversedMessage: 'Bill journal entry was already reversed',
      notPostedMessage: 'Bill is not posted',
      lock: async (tx) => {
        const rows = await tx.$queryRaw<
          { status: string; amount_paid: string }[]
        >`
          SELECT status, amount_paid FROM purchase_bills WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
        return rows[0];
      },
      applyInTx: async (tx, locked) => {
        if (Number(locked.amount_paid) !== 0) {
          throw new ConflictDomainError('Cannot void a bill with payments', {
            id,
          });
        }
        await tx.purchaseBill.update({
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
    bill: PurchaseBill,
  ): PurchaseBill & { outstanding: string; paymentStatus: string } {
    const total = Money.of(bill.total.toString());
    const paid = Money.of(bill.amountPaid.toString());
    const outstanding = total.subtract(paid);
    const paymentStatus = paid.isZero()
      ? 'UNPAID'
      : outstanding.isZero() || outstanding.isNegative()
        ? 'PAID'
        : 'PARTIAL';
    const lines = (bill as PurchaseBill & { lines?: Record<string, unknown>[] })
      .lines;
    return {
      ...serializeMoney(bill, [
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
}
