import { Injectable } from '@nestjs/common';
import { JournalEntry, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  PostingService,
  LedgerTx,
  POSTING_TX_OPTIONS,
} from '../ledger/posting/posting.service';
import {
  TaxService,
  TaxableLineInput,
  TaxCalculation,
} from '../tax/tax.service';
import { DocumentNumberService } from './document-number.service';
import { ValidationFailedError } from '../common/errors/domain-errors';
import { Money } from '../common/money/money';
import {
  assertDocumentLineAccounts,
  assertTaxLineAccounts,
} from './document-account-rules';

export interface PostTaxedDocParams {
  nature: 'SALE' | 'PURCHASE';
  settlementAccountId: string;
  date: Date;
  description: string;
  sourceType: 'SALES_INVOICE' | 'PURCHASE_BILL';
  sourceId: string;
  createdBy: string;
  postedBy: string;
  documentType: string; // 'INV' | 'BILL'
  lines: TaxableLineInput[];
  /** Table the source document lives in — a constant literal, never user input. */
  table: 'sales_invoices' | 'purchase_bills';
  /** Runs right after the source row is locked FOR UPDATE and re-checked DRAFT.
   *  Must re-read the document through `tx` and throw if its postable content
   *  (date, description, lines) differs from what `date`/`description`/`lines`
   *  above were derived from — so the entry posted is always the locked row's. */
  verifyLockedInTx: (tx: LedgerTx) => Promise<void>;
  /** Type-specific "no longer a draft" message (from documentMessages(spec)). */
  notDraftMessage: string;
}

export interface PostedDocContext {
  tx: LedgerTx;
  number: number;
  ref: string;
  entry: JournalEntry;
  fiscalYear: number;
  totals: {
    subtotal: string;
    taxTotal: string;
    withholdingTotal: string;
    total: string;
  };
}

@Injectable()
export class DocumentPostingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
    private readonly tax: TaxService,
    private readonly docNumber: DocumentNumberService,
  ) {}

  /** Assemble the stored document totals from a tax calculation. The PPN/PPh split
   *  (taxTotal vs withholdingTotal) is computed once, inside TaxService. */
  private summarize(calc: TaxCalculation): {
    subtotal: string;
    taxTotal: string;
    withholdingTotal: string;
    total: string;
  } {
    return {
      subtotal: calc.subtotal,
      taxTotal: calc.taxTotal,
      withholdingTotal: calc.withholdingTotal,
      total: calc.settlementAmount,
    };
  }

  /** Compute the tax breakdown for a draft (no posting). */
  async computeTotals(
    nature: 'SALE' | 'PURCHASE',
    settlementAccountId: string,
    lines: TaxableLineInput[],
    db?: LedgerTx,
  ): Promise<{
    subtotal: string;
    taxTotal: string;
    withholdingTotal: string;
    total: string;
  }> {
    const calc = await this.tax.calculate(
      {
        nature,
        settlementAccountId,
        lines,
      },
      db,
    );
    return this.summarize(calc);
  }

  /** Post a taxed document atomically. The source row is locked (FOR UPDATE) and
   *  re-checked still-DRAFT internally, then `verifyLockedInTx` proves the lines
   *  the entry was derived from are the ones stored under that lock (a draft edit
   *  serializes on the same row lock), before a number is consumed. Lock order:
   *  document row → fiscal-year advisory lock / period FOR SHARE → sequences.
   *  `finalize` updates the document row to POSTED with the assigned number/ref +
   *  journal entry id. */
  async post(
    params: PostTaxedDocParams,
    finalize: (ctx: PostedDocContext) => Promise<void>,
  ): Promise<void> {
    const calc = await this.tax.calculate({
      nature: params.nature,
      settlementAccountId: params.settlementAccountId,
      lines: params.lines,
    });
    const journalInput = {
      date: params.date,
      description: params.description,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      createdBy: params.createdBy,
      lines: calc.journalLines,
    };
    const prepared = await this.posting.preparePosting(
      journalInput,
      params.postedBy,
    );
    await this.prisma.transaction(async (tx) => {
      await this.lockDraftInTx(
        tx,
        params.table,
        params.sourceId,
        params.notDraftMessage,
      );
      // The locked row must still hold exactly the content the entry was
      // derived from; otherwise an edit committed after the pre-read.
      await params.verifyLockedInTx(tx);
      // Post-time re-validation of the (now verified-current) line accounts:
      // they must still satisfy the document line rules (catches drafts
      // written before the rules existed).
      await assertDocumentLineAccounts(
        tx,
        params.nature,
        params.lines.map((l) => l.accountId),
      );
      // ...and every account a (non-zero) tax line posts to must still pass
      // the tax-account rule for its code's kind.
      await assertTaxLineAccounts(
        tx,
        calc.taxes.filter((t) => !Money.of(t.amount).isZero()),
      );
      const number = await this.docNumber.next(
        tx,
        params.documentType,
        prepared.fiscalYear,
      );
      const ref = this.docNumber.buildRef(
        params.documentType,
        prepared.fiscalYear,
        number,
      );
      const entry = await this.posting.createPostedEntryInTx(tx, prepared);
      await finalize({
        tx,
        number,
        ref,
        entry,
        fiscalYear: prepared.fiscalYear,
        totals: this.summarize(calc),
      });
      // Same bounded wait as direct posting: a post racing a draft edit /
      // another post waits out the row lock instead of Prisma's 5s default.
    }, POSTING_TX_OPTIONS);
  }

  /** FOR UPDATE the source row and re-check it is still DRAFT, before a number is
   *  consumed. `table` is a constant union literal supplied by the adapter (never
   *  user input), so Prisma.raw(table) is injection-safe; `id` is a bound param. */
  private async lockDraftInTx(
    tx: LedgerTx,
    table: 'sales_invoices' | 'purchase_bills',
    id: string,
    notDraftMessage: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ status: string }[]>(
      Prisma.sql`SELECT status FROM ${Prisma.raw(table)} WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`,
    );
    if (rows.length === 0 || rows[0].status !== 'DRAFT')
      throw new ValidationFailedError(notDraftMessage, { id });
  }
}
