import { Injectable } from '@nestjs/common';
import { JournalEntry, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import { PostingService, LedgerTx } from '../ledger/posting/posting.service';
import {
  TaxService,
  TaxableLineInput,
  TaxCalculation,
} from '../tax/tax.service';
import { DocumentNumberService } from './document-number.service';
import { ValidationFailedError } from '../common/errors/domain-errors';

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

  /** Split a tax calculation into the stored document totals. */
  private summarize(calc: TaxCalculation): {
    subtotal: string;
    taxTotal: string;
    withholdingTotal: string;
    total: string;
  } {
    let taxTotal = Money.zero();
    let withholdingTotal = Money.zero();
    for (const t of calc.taxes) {
      if (t.kind === 'PPN_OUTPUT' || t.kind === 'PPN_INPUT')
        taxTotal = taxTotal.add(Money.of(t.amount));
      else withholdingTotal = withholdingTotal.add(Money.of(t.amount));
    }
    return {
      subtotal: calc.subtotal,
      taxTotal: taxTotal.toPersistence(),
      withholdingTotal: withholdingTotal.toPersistence(),
      total: calc.settlementAmount,
    };
  }

  /** Compute the tax breakdown for a draft (no posting). */
  async computeTotals(
    nature: 'SALE' | 'PURCHASE',
    settlementAccountId: string,
    lines: TaxableLineInput[],
  ): Promise<{
    subtotal: string;
    taxTotal: string;
    withholdingTotal: string;
    total: string;
  }> {
    const calc = await this.tax.calculate({
      nature,
      settlementAccountId,
      lines,
    });
    return this.summarize(calc);
  }

  /** Post a taxed document atomically. The source row is locked (FOR UPDATE) and
   *  re-checked still-DRAFT internally, before a number is consumed; `finalize`
   *  updates the document row to POSTED with the assigned number/ref + journal
   *  entry id. */
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
    await this.prisma.client.$transaction(async (tx) => {
      await this.lockDraftInTx(
        tx,
        params.table,
        params.sourceId,
        params.notDraftMessage,
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
    });
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
