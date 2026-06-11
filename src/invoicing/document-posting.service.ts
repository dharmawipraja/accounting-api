import { Injectable } from '@nestjs/common';
import { JournalEntry } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import { PostingService, LedgerTx } from '../ledger/posting/posting.service';
import { TaxService, TaxableLineInput } from '../tax/tax.service';
import { DocumentNumberService } from './document-number.service';

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
}

export interface PostedDocContext {
  tx: LedgerTx;
  number: number;
  ref: string;
  entry: JournalEntry;
  fiscalYear: number;
}

@Injectable()
export class DocumentPostingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
    private readonly tax: TaxService,
    private readonly docNumber: DocumentNumberService,
  ) {}

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

  /** Post a taxed document atomically. `lockDraft` must lock + re-check the row is
   *  still DRAFT (FOR UPDATE) BEFORE a number is consumed; `finalize` updates the
   *  document row to POSTED with the assigned number/ref + journal entry id. */
  async post(
    params: PostTaxedDocParams,
    lockDraft: (tx: LedgerTx) => Promise<void>,
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
    const { periodId, fiscalYear } = await this.posting.preparePosting(
      journalInput,
      params.postedBy,
    );
    await this.prisma.client.$transaction(async (tx) => {
      await lockDraft(tx);
      const number = await this.docNumber.next(
        tx,
        params.documentType,
        fiscalYear,
      );
      const ref = this.docNumber.buildRef(
        params.documentType,
        fiscalYear,
        number,
      );
      const entry = await this.posting.createPostedEntryInTx(
        tx,
        journalInput,
        params.postedBy,
        periodId,
        fiscalYear,
      );
      await finalize({ tx, number, ref, entry, fiscalYear });
    });
  }
}
