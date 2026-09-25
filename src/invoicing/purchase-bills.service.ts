import { Injectable } from '@nestjs/common';
import { DocumentStatus, PurchaseBill, PurchaseBillLine } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { TaxedDocumentService } from './taxed-document.service';
import { presentDocument } from './document-presenter';
import { DocumentDescriptor } from './document-descriptor';
import { mapUniqueViolation } from '../common/errors/map-unique-violation';

/** The only unique a bill create/update can hit is the live (partner,
 *  vendor_invoice_no) partial index → 409; anything else rethrows unchanged. */
function duplicateVendorInvoice(
  err: unknown,
  partnerId: string,
  vendorInvoiceNo: string | null | undefined,
): never {
  mapUniqueViolation(
    err,
    'This vendor invoice number is already recorded on another live bill for this vendor',
    { partnerId, vendorInvoiceNo },
  );
}

export type PurchaseBillRow = PurchaseBill & { lines?: PurchaseBillLine[] };

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
  private readonly spec: DocumentDescriptor<
    PurchaseBillRow,
    CreateBillInput,
    UpdateBillInput
  >;

  constructor(
    private readonly prisma: PrismaService,
    private readonly docs: TaxedDocumentService,
  ) {
    this.spec = {
      noun: 'bill',
      label: 'Purchase bill',
      article: 'a',
      partnerFlag: 'isVendor',
      nature: 'PURCHASE',
      controlRole: 'AP_CONTROL',
      sourceType: 'PURCHASE_BILL',
      documentType: 'BILL',
      table: 'purchase_bills',
      allocationColumn: 'purchase_bill_id',
      trigramColumns: ['bill_ref', 'vendor_invoice_no', 'description'],
      model: this.prisma.client.purchaseBill,
      findById: (id, db = this.prisma.client) =>
        db.purchaseBill.findFirst({
          where: { id },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        }),
      page: async ({ where, limit, offset }) => {
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
      hydrate: (ids) =>
        this.prisma.client.purchaseBill.findMany({
          where: { id: { in: ids } },
        }),
      createRow: (tx, { lines, ...scalars }, input) =>
        tx.purchaseBill
          .create({
            data: {
              ...scalars,
              vendorInvoiceNo: input.vendorInvoiceNo,
              lines: { create: lines.create },
            },
            include: { lines: { orderBy: { lineNo: 'asc' } } },
          })
          .catch((err: unknown) =>
            duplicateVendorInvoice(
              err,
              scalars.partnerId,
              input.vendorInvoiceNo,
            ),
          ),
      updateRow: async (tx, id, { lines, ...scalars }, input, existing) => {
        await tx.purchaseBillLine.deleteMany({ where: { purchaseBillId: id } });
        const vendorInvoiceNo =
          input.vendorInvoiceNo ?? existing.vendorInvoiceNo;
        await tx.purchaseBill
          .update({
            where: { id },
            data: {
              ...scalars,
              vendorInvoiceNo,
              lines: { create: lines.create },
            },
          })
          .catch((err: unknown) =>
            duplicateVendorInvoice(err, existing.partnerId, vendorInvoiceNo),
          );
      },
      finalizePosted: async (tx, id, ctx, postedBy) => {
        await tx.purchaseBill.update({
          where: { id },
          data: {
            status: 'POSTED',
            billNumber: ctx.number,
            billRef: ctx.ref,
            fiscalYear: ctx.fiscalYear,
            journalEntryId: ctx.entry.id,
            postedBy,
            postedAt: new Date(),
            subtotal: ctx.totals.subtotal,
            taxTotal: ctx.totals.taxTotal,
            withholdingTotal: ctx.totals.withholdingTotal,
            total: ctx.totals.total,
          },
        });
      },
      markVoid: async (tx, id, voidedOn) => {
        await tx.purchaseBill.update({
          where: { id },
          data: { status: 'VOID', voidedOn },
        });
      },
    };
  }

  createDraft(input: CreateBillInput): Promise<PurchaseBillRow> {
    return this.docs.createDraft(this.spec, input);
  }
  update(id: string, input: UpdateBillInput): Promise<PurchaseBillRow> {
    return this.docs.update(this.spec, id, input);
  }
  getById(id: string): Promise<PurchaseBillRow> {
    return this.docs.getById(this.spec, id);
  }
  listPage(q: {
    q?: string;
    partnerId?: string;
    status?: DocumentStatus;
    limit?: number;
    offset?: number;
  }) {
    return this.docs.listPage(this.spec, q);
  }
  deleteDraft(id: string, deletedBy: string): Promise<void> {
    return this.docs.deleteDraft(this.spec, id, deletedBy);
  }
  post(id: string, postedBy: string): Promise<PurchaseBillRow> {
    return this.docs.post(this.spec, id, postedBy);
  }
  void(id: string, voidedBy: string, date?: Date): Promise<PurchaseBillRow> {
    return this.docs.void(this.spec, id, voidedBy, date);
  }
  present(row: PurchaseBillRow) {
    return presentDocument(row);
  }
}
