import { AccountRole, DocumentStatus, Prisma } from '@prisma/client';
import { LedgerTx } from '../ledger/posting/posting.service';
import { PostedDocContext } from './document-posting.service';
import { SoftDeletableModel } from '../ledger/document-lifecycle.service';

/** A document line as read back from the DB (Decimal money columns). */
export interface DocumentLineRow {
  lineNo?: number;
  description: string;
  accountId: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  amount: Prisma.Decimal;
  taxCodeIds: string[];
}

/** Structural shape every taxed-document row shares; lets presentDocument stay generic. */
export interface DocumentRow {
  id: string;
  status: DocumentStatus;
  partnerId: string;
  date: Date;
  dueDate: Date | null;
  description: string | null;
  createdBy: string;
  journalEntryId: string | null;
  subtotal: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  withholdingTotal: Prisma.Decimal;
  total: Prisma.Decimal;
  amountPaid: Prisma.Decimal;
  lines?: DocumentLineRow[];
}

/** A document line as supplied by a caller (4dp strings). */
export interface DocumentLineInput {
  description: string;
  accountId: string;
  quantity: string;
  unitPrice: string;
  taxCodeIds: string[];
}

/** A line ready for a Prisma nested create. */
export interface DocumentLineCreateData {
  lineNo: number;
  description: string;
  accountId: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  taxCodeIds: string[];
}

export interface CreateDocumentInput {
  partnerId: string;
  date: Date;
  dueDate?: Date;
  description?: string;
  lines: DocumentLineInput[];
  createdBy: string;
}

export interface UpdateDocumentInput {
  date?: Date;
  dueDate?: Date;
  description?: string;
  lines?: DocumentLineInput[];
}

export interface DocumentTotals {
  subtotal: string;
  taxTotal: string;
  withholdingTotal: string;
  total: string;
}

/** Common create-row data the shared module computes once; the descriptor's
 *  createRow merges any type-specific delta (e.g. vendorInvoiceNo). */
export interface DocumentCreateCommon extends DocumentTotals {
  partnerId: string;
  date: Date;
  dueDate?: Date;
  description?: string;
  createdBy: string;
  lines: { create: DocumentLineCreateData[] };
}

export interface DocumentUpdateCommon extends DocumentTotals {
  date: Date;
  dueDate: Date | null;
  description: string | null;
  lines: { create: DocumentLineCreateData[] };
}

export interface DocumentListWhere {
  partnerId?: string;
  status?: DocumentStatus;
}

/** The label-bearing subset of a descriptor used to build error messages. */
export interface DocumentLabels {
  noun: string; // 'invoice' | 'bill'
  label: string; // 'Sales invoice' | 'Purchase bill'
  article: 'a' | 'an';
  partnerFlag: 'isCustomer' | 'isVendor';
}

/** The typed adapter to one document type's Prisma delegate. */
export interface DocumentDescriptor<
  TRow extends DocumentRow,
  TCreate extends CreateDocumentInput,
  TUpdate extends UpdateDocumentInput,
> extends DocumentLabels {
  nature: 'SALE' | 'PURCHASE';
  controlRole: AccountRole;
  sourceType: 'SALES_INVOICE' | 'PURCHASE_BILL';
  documentType: string; // 'INV' | 'BILL'
  table: 'sales_invoices' | 'purchase_bills';
  /** Own searched columns for fuzzy ?q= search — a non-empty tuple (trigramSearch requires ≥1). */
  trigramColumns: [string, ...string[]];
  model: SoftDeletableModel;
  findById(id: string): Promise<TRow | null>;
  page(a: {
    where: DocumentListWhere;
    limit: number;
    offset: number;
  }): Promise<{ rows: TRow[]; total: number }>;
  hydrate(ids: string[]): Promise<TRow[]>;
  createRow(common: DocumentCreateCommon, input: TCreate): Promise<TRow>;
  updateRow(
    tx: LedgerTx,
    id: string,
    common: DocumentUpdateCommon,
    input: TUpdate,
    existing: TRow,
  ): Promise<void>;
  finalizePosted(
    tx: LedgerTx,
    id: string,
    ctx: PostedDocContext,
    postedBy: string,
  ): Promise<void>;
  markVoid(tx: LedgerTx, id: string): Promise<void>;
}
