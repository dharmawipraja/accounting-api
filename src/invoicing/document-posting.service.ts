import { Injectable } from '@nestjs/common';
import { JournalEntry } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  PostingService,
  POSTING_TX_OPTIONS,
} from '../ledger/posting/posting.service';
import type { LedgerTx } from '../common/prisma/prisma.service';
import {
  TaxService,
  TaxableLineInput,
  TaxableTransaction,
  TaxCalculation,
  CalculatedLine,
} from '../tax/tax.service';

/** The note-only tax-engine options (see TaxableTransaction). */
type NoteTaxOptions = Pick<
  TaxableTransaction,
  'allowInactiveCodes' | 'overrideAmounts'
>;
import { ValidationFailedError } from '../common/errors/domain-errors';
import { lockLiveRow } from '../common/db/lock-live-row';
import { Money } from '../common/money/money';
import {
  assertDocumentLineAccountsPostable,
  assertTaxLineAccounts,
} from './document-account-rules';
import type {
  DocumentTotals,
  TaxedSourceType,
  TaxedTable,
} from './document-descriptor';
import { nextDocumentNumber, sameTaxCalculation } from './document-helpers';

/** Internal signal: the locked draft (or the tax state its entry was derived
 *  from) no longer matches the pre-lock read. The caller restarts the post
 *  from a fresh read (bounded — TaxedDocumentService.MAX_POST_ATTEMPTS). */
export class DraftChangedError extends Error {}

interface PostTaxedDocParams {
  nature: 'SALE' | 'PURCHASE';
  settlementAccountId: string;
  date: Date;
  description: string;
  sourceType: TaxedSourceType;
  sourceId: string;
  createdBy: string;
  postedBy: string;
  documentType: string; // 'INV' | 'BILL' | 'CN' | 'DN'
  lines: TaxableLineInput[];
  /** Credit/debit notes: inactive original codes + per-code overrides. */
  taxOptions?: NoteTaxOptions;
  /** Table the source document lives in — a constant literal, never user input. */
  table: TaxedTable;
  /** Reshape the tax calculation's journal before posting (credit/debit
   *  notes: mirror it and split the settlement); default = as calculated. */
  journalLines?: (lines: CalculatedLine[]) => CalculatedLine[];
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
  totals: DocumentTotals;
}

/** The stored document totals of a tax calculation (the PPN/PPh split —
 *  taxTotal vs withholdingTotal — is computed once, inside TaxService). */
function documentTotals(calc: TaxCalculation): DocumentTotals {
  return {
    subtotal: calc.subtotal,
    taxTotal: calc.taxTotal,
    withholdingTotal: calc.withholdingTotal,
    total: calc.settlementAmount,
  };
}

@Injectable()
export class DocumentPostingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
    private readonly tax: TaxService,
  ) {}

  /** Compute the tax breakdown for a draft (no posting). */
  async computeTotals(
    nature: 'SALE' | 'PURCHASE',
    settlementAccountId: string,
    lines: TaxableLineInput[],
    db?: LedgerTx,
    taxOptions?: NoteTaxOptions,
  ): Promise<DocumentTotals> {
    return documentTotals(
      await this.tax.calculate(
        { nature, settlementAccountId, lines, ...taxOptions },
        db,
      ),
    );
  }

  /** Post a taxed document atomically. The source row is locked (FOR UPDATE) and
   *  re-checked still-DRAFT internally, then `verifyLockedInTx` proves the lines
   *  the entry was derived from are the ones stored under that lock (a draft edit
   *  serializes on the same row lock) and the tax calculation is re-run through
   *  `tx` and must equal the pre-tx one (else DraftChangedError → restart),
   *  before a number is consumed. Lock / read order inside the tx:
   *  document row FOR UPDATE → partner FOR SHARE (`verifyLockedInTx`) → tax-code
   *  + company-settings reads, the postable-account check of EVERY line
   *  account and the line/tax account-rule reads (plain) →
   *  document sequence (lock-and-increment) → fiscal-year advisory lock (shared)
   *  + period FOR SHARE → accounts FOR SHARE → journal-entry sequence (the last
   *  three inside `createPostedEntryInTx` / `stampPostedInTx`).
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
      ...params.taxOptions,
    });
    const journalInput = {
      date: params.date,
      description: params.description,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      createdBy: params.createdBy,
      lines: params.journalLines
        ? params.journalLines(calc.journalLines)
        : calc.journalLines,
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
      // Re-derive the tax through `tx` (tax codes AND company settings read on
      // this connection, after the lock): a tax-code rate/account change that
      // committed after the pre-tx calculation restarts the post; a code now
      // inactive/unknown or an isPkp flip surfaces as the calculation's 422.
      const lockedCalc = await this.tax.calculate(
        {
          nature: params.nature,
          settlementAccountId: params.settlementAccountId,
          lines: params.lines,
          ...params.taxOptions,
        },
        tx,
      );
      if (!sameTaxCalculation(calc, lockedCalc)) throw new DraftChangedError();
      // Post-time re-validation of EVERY (now verified-current) line account
      // — including a zero-amount (free) line, which leaves no journal line
      // and so escapes the journal's FOR SHARE account check — with the same
      // rules, in the same order, as a draft create/PATCH: exists, live,
      // postable, active (422 INVALID_ACCOUNT), then the document line rules
      // (catches drafts written before the rules existed). Draft and post
      // therefore agree on every line.
      await assertDocumentLineAccountsPostable(
        this.posting,
        tx,
        params,
        params.lines.map((l) => l.accountId),
      );
      // ...and every account a (non-zero) tax line posts to must still pass
      // the tax-account rule for its code's kind.
      await assertTaxLineAccounts(
        tx,
        calc.taxes.filter((t) => !Money.of(t.amount).isZero()),
      );
      const { number, ref } = await nextDocumentNumber(
        tx,
        params.documentType,
        prepared.fiscalYear,
      );
      const entry = await this.posting.createPostedEntryInTx(tx, prepared);
      await finalize({
        tx,
        number,
        ref,
        entry,
        fiscalYear: prepared.fiscalYear,
        totals: documentTotals(calc),
      });
      // Same bounded wait as direct posting: a post racing a draft edit /
      // another post waits out the row lock instead of Prisma's 5s default.
    }, POSTING_TX_OPTIONS);
  }

  /** FOR UPDATE the source row and re-check it is still DRAFT, before a number is
   *  consumed. `table` is a constant union literal supplied by the adapter. */
  private async lockDraftInTx(
    tx: LedgerTx,
    table: TaxedTable,
    id: string,
    notDraftMessage: string,
  ): Promise<void> {
    const row = await lockLiveRow<{ status: string }>(tx, table, id, 'status');
    if (!row || row.status !== 'DRAFT')
      throw new ValidationFailedError(notDraftMessage, { id });
  }
}
