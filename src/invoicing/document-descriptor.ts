import {
  AccountRole,
  DocumentStatus,
  Prisma,
  TaxInvoiceStatus,
} from '@prisma/client';
import type { LedgerTx } from '../common/prisma/prisma.service';
import type { PostedDocContext } from './document-posting.service';
import type { CalculatedLine, TaxBreakdownRow } from '../tax/tax.service';
import { SoftDeletableModel } from '../ledger/document-lifecycle.service';

/** A document line as read back from the DB (Decimal money columns). */
export interface DocumentLineRow {
  lineNo?: number;
  description: string;
  accountId: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  discountPercent: Prisma.Decimal | null;
  discountAmount: Prisma.Decimal;
  amount: Prisma.Decimal;
  taxCodeIds: string[];
}

/** Structural shape every taxed-document row shares (invoices, bills, and
 *  credit/debit notes). */
export interface TaxedRow {
  id: string;
  status: DocumentStatus;
  partnerId: string;
  date: Date;
  description: string | null;
  createdBy: string;
  journalEntryId: string | null;
  subtotal: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  withholdingTotal: Prisma.Decimal;
  total: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  lines?: DocumentLineRow[];
}

/** An invoice / bill row: a taxed row that is settled (payments, notes) and
 *  ages; lets presentDocument stay generic. */
export interface DocumentRow extends TaxedRow {
  dueDate: Date | null;
  amountPaid: Prisma.Decimal;
  creditedTotal: Prisma.Decimal;
}

/** The journal source types of taxed documents. */
export type TaxedSourceType =
  | 'SALES_INVOICE'
  | 'PURCHASE_BILL'
  | 'SALES_CREDIT_NOTE'
  | 'PURCHASE_DEBIT_NOTE';

/** Their tables — constant literals, never user input (safe for Prisma.raw). */
export type TaxedTable =
  | 'sales_invoices'
  | 'purchase_bills'
  | 'sales_credit_notes'
  | 'purchase_debit_notes';

/** A document line as supplied by a caller (4dp strings). */
export interface DocumentLineInput {
  description: string;
  accountId: string;
  quantity: string;
  unitPrice: string;
  /** Percent OR fixed amount (mutually exclusive in the DTO); omitted = none. */
  discountPercent?: string | null;
  discountAmount?: string | null;
  taxCodeIds: string[];
}

/** A line ready for a Prisma nested create. */
export interface DocumentLineCreateData {
  lineNo: number;
  description: string;
  accountId: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string | null;
  discountAmount: string;
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
  /** `null` clears the stored due date; `undefined` keeps it. */
  dueDate?: Date | null;
  /** `null` clears the stored description; `undefined` keeps it. */
  description?: string | null;
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
  discountTotal: string;
  lines: { create: DocumentLineCreateData[] };
}

export interface DocumentUpdateCommon extends DocumentTotals {
  date: Date;
  /** Absent for a document type without a due date (notes). */
  dueDate?: Date | null;
  description: string | null;
  discountTotal: string;
  lines: { create: DocumentLineCreateData[] };
}

export interface DocumentListWhere {
  partnerId?: string;
  status?: DocumentStatus;
  /** Sales invoices only. */
  taxInvoiceStatus?: TaxInvoiceStatus;
}

/** The label-bearing subset of a descriptor used to build error messages. */
export interface DocumentLabels {
  noun: string; // 'invoice' | 'bill' | 'credit note' | 'debit note'
  label: string; // 'Sales invoice' | 'Purchase bill' | …
  article: 'a' | 'an';
  partnerFlag: 'isCustomer' | 'isVendor';
}

/** The typed adapter to one document type's Prisma delegate. */
export interface DocumentDescriptor<
  TRow extends TaxedRow,
  TCreate extends CreateDocumentInput = CreateDocumentInput,
  TUpdate extends UpdateDocumentInput = UpdateDocumentInput,
> extends DocumentLabels {
  nature: 'SALE' | 'PURCHASE';
  controlRole: AccountRole;
  sourceType: TaxedSourceType;
  documentType: string; // 'INV' | 'BILL' | 'CN' | 'DN'
  table: TaxedTable;
  /** This document type's FK column on payment_allocations (invoices/bills). */
  allocationColumn?: 'sales_invoice_id' | 'purchase_bill_id';
  /** Invoices/bills: the notes that return part of them (void guard). */
  notes?: {
    table: 'sales_credit_notes' | 'purchase_debit_notes';
    noun: string;
  };
  /** Credit/debit notes: they reuse the ORIGINAL's partner, line accounts and
   *  tax codes, which may since have been deactivated (e.g. a rate change
   *  retires a code). Inactive is then accepted; deleted, partner flag and
   *  kind/nature rules still apply. (Accounts: the note source types' posting
   *  policy, accountPolicyFor.) Invoices/bills stay strict. */
  allowInactiveRefs?: boolean;
  /** Own searched columns for fuzzy ?q= search — a non-empty tuple (trigramSearch requires ≥1). */
  trigramColumns: [string, ...string[]];
  model: SoftDeletableModel;
  /** Read the row with its lines; `db` = a transaction to read under its locks. */
  findById(id: string, db?: LedgerTx): Promise<TRow | null>;
  page(a: {
    where: DocumentListWhere;
    limit: number;
    offset: number;
  }): Promise<{ rows: TRow[]; total: number }>;
  hydrate(ids: string[]): Promise<TRow[]>;
  /** Runs inside PrismaService.transaction so an idempotent create marks its
   *  key committed atomically with the insert. */
  createRow(
    tx: LedgerTx,
    common: DocumentCreateCommon,
    input: TCreate,
  ): Promise<TRow>;
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
  markVoid(tx: LedgerTx, id: string, voidedOn: Date): Promise<void>;
  /** API shape of a row (list + single reads). */
  present(row: TRow): unknown;
  /** Optional extra posting steps (credit/debit notes): planned from the
   *  pre-lock read of each post attempt. */
  postHooks?(row: TRow): Promise<DocumentPostHooks>;
}

/** Extra steps a document type adds to the shared post (see
 *  DocumentPostingService.post): reshape the tax journal, verify more state
 *  under the document lock (throw DraftChangedError when it moved since the
 *  plan — the post restarts), and write more rows in the same tx. */
export interface DocumentPostHooks {
  journalLines(lines: CalculatedLine[]): CalculatedLine[];
  /** Per-code tax amount overrides (TaxableTransaction.overrideAmounts). */
  overrideTaxAmounts?(raw: readonly TaxBreakdownRow[]): Record<string, string>;
  verifyInTx(tx: LedgerTx): Promise<void>;
  finalizeInTx(tx: LedgerTx, ctx: PostedDocContext): Promise<void>;
}
