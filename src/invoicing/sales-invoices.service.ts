import { Injectable } from '@nestjs/common';
import { DocumentStatus, SalesInvoice, SalesInvoiceLine } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { TaxedDocumentService } from './taxed-document.service';
import { presentDocument } from './document-presenter';
import {
  CreateDocumentInput,
  DocumentDescriptor,
  UpdateDocumentInput,
} from './document-descriptor';

export type SalesInvoiceRow = SalesInvoice & { lines?: SalesInvoiceLine[] };

@Injectable()
export class SalesInvoicesService {
  private readonly spec: DocumentDescriptor<SalesInvoiceRow>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly docs: TaxedDocumentService,
  ) {
    this.spec = {
      noun: 'invoice',
      label: 'Sales invoice',
      article: 'an',
      partnerFlag: 'isCustomer',
      nature: 'SALE',
      controlRole: 'AR_CONTROL',
      sourceType: 'SALES_INVOICE',
      documentType: 'INV',
      table: 'sales_invoices',
      allocationColumn: 'sales_invoice_id',
      trigramColumns: ['invoice_ref', 'description'],
      model: this.prisma.client.salesInvoice,
      findById: (id, db = this.prisma.client) =>
        db.salesInvoice.findFirst({
          where: { id },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        }),
      page: async ({ where, limit, offset }) => {
        const [rows, total] = await Promise.all([
          this.prisma.client.salesInvoice.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: limit,
            skip: offset,
          }),
          this.prisma.client.salesInvoice.count({ where }),
        ]);
        return { rows, total };
      },
      hydrate: (ids) =>
        this.prisma.client.salesInvoice.findMany({
          where: { id: { in: ids } },
        }),
      createRow: (tx, { lines, ...scalars }) =>
        tx.salesInvoice.create({
          data: { ...scalars, lines: { create: lines.create } },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        }),
      updateRow: async (tx, id, { lines, ...scalars }) => {
        await tx.salesInvoiceLine.deleteMany({ where: { salesInvoiceId: id } });
        await tx.salesInvoice.update({
          where: { id },
          data: { ...scalars, lines: { create: lines.create } },
        });
      },
      finalizePosted: async (tx, id, ctx, postedBy) => {
        await tx.salesInvoice.update({
          where: { id },
          data: {
            status: 'POSTED',
            invoiceNumber: ctx.number,
            invoiceRef: ctx.ref,
            fiscalYear: ctx.fiscalYear,
            journalEntryId: ctx.entry.id,
            postedBy,
            postedAt: new Date(),
            ...ctx.totals,
          },
        });
      },
      markVoid: async (tx, id, voidedOn) => {
        await tx.salesInvoice.update({
          where: { id },
          data: { status: 'VOID', voidedOn },
        });
      },
    };
  }

  createDraft(input: CreateDocumentInput): Promise<SalesInvoiceRow> {
    return this.docs.createDraft(this.spec, input);
  }
  update(id: string, input: UpdateDocumentInput): Promise<SalesInvoiceRow> {
    return this.docs.update(this.spec, id, input);
  }
  getById(id: string): Promise<SalesInvoiceRow> {
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
  post(id: string, postedBy: string): Promise<SalesInvoiceRow> {
    return this.docs.post(this.spec, id, postedBy);
  }
  void(id: string, voidedBy: string, date?: Date): Promise<SalesInvoiceRow> {
    return this.docs.void(this.spec, id, voidedBy, date);
  }
  present(row: SalesInvoiceRow) {
    return presentDocument(row);
  }
}
