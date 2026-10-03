import { Injectable } from '@nestjs/common';
import {
  CoretaxItemType,
  DocumentStatus,
  SalesInvoice,
  SalesInvoiceLine,
  TaxInvoiceStatus,
} from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { TaxedDocumentService } from './taxed-document.service';
import { presentDocument } from './document-presenter';
import {
  CreateDocumentInput,
  DocumentDescriptor,
  DocumentLineCreateData,
  DocumentLineInput,
  UpdateDocumentInput,
} from './document-descriptor';

export type SalesInvoiceRow = SalesInvoice & { lines?: SalesInvoiceLine[] };

/** The Coretax faktur fields of a sales invoice line (null = company default). */
interface CoretaxLineFields {
  coretaxItemType?: CoretaxItemType | null;
  coretaxItemCode?: string | null;
  coretaxUnitCode?: string | null;
}
export type SalesInvoiceLineInput = DocumentLineInput & CoretaxLineFields;
export type CreateInvoiceInput = CreateDocumentInput & {
  lines: SalesInvoiceLineInput[];
  trxCode?: string | null;
};
export type UpdateInvoiceInput = UpdateDocumentInput & {
  lines?: SalesInvoiceLineInput[];
  /** `null` clears it; `undefined` keeps it. */
  trxCode?: string | null;
};

/** The shared line rows (built in order from `src`) + each source line's
 *  Coretax fields — not part of the posted content. */
function withCoretax(rows: DocumentLineCreateData[], src: CoretaxLineFields[]) {
  return rows.map((r, i) => ({
    ...r,
    coretaxItemType: src[i]?.coretaxItemType ?? null,
    coretaxItemCode: src[i]?.coretaxItemCode ?? null,
    coretaxUnitCode: src[i]?.coretaxUnitCode ?? null,
  }));
}

@Injectable()
export class SalesInvoicesService {
  private readonly spec: DocumentDescriptor<
    SalesInvoiceRow,
    CreateInvoiceInput,
    UpdateInvoiceInput
  >;

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
      notes: { table: 'sales_credit_notes', noun: 'credit note' },
      trigramColumns: ['invoice_ref', 'description'],
      model: this.prisma.client.salesInvoice,
      present: (r) => presentDocument(r),
      findById: (id, db = this.prisma.client) =>
        db.salesInvoice.findFirst({
          where: { id },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        }),
      createRow: (tx, { lines, ...scalars }, input) =>
        tx.salesInvoice.create({
          data: {
            ...scalars,
            trxCode: input.trxCode ?? null,
            lines: { create: withCoretax(lines.create, input.lines) },
          },
          include: { lines: { orderBy: { lineNo: 'asc' } } },
        }),
      updateRow: async (tx, id, { lines, ...scalars }, input, existing) => {
        await tx.salesInvoiceLine.deleteMany({ where: { salesInvoiceId: id } });
        // Omitted lines are rebuilt from the stored ones (same order), so
        // their Coretax fields are kept too.
        const src = input.lines ?? existing.lines ?? [];
        await tx.salesInvoice.update({
          where: { id },
          data: {
            ...scalars,
            trxCode: input.trxCode,
            lines: { create: withCoretax(lines.create, src) },
          },
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

  createDraft(input: CreateInvoiceInput): Promise<SalesInvoiceRow> {
    return this.docs.createDraft(this.spec, input);
  }
  update(id: string, input: UpdateInvoiceInput): Promise<SalesInvoiceRow> {
    return this.docs.update(this.spec, id, input);
  }
  getById(id: string): Promise<SalesInvoiceRow> {
    return this.docs.getById(this.spec, id);
  }
  listPage(q: {
    q?: string;
    partnerId?: string;
    status?: DocumentStatus;
    taxInvoiceStatus?: TaxInvoiceStatus;
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
