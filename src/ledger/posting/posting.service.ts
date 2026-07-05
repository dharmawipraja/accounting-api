import { Injectable } from '@nestjs/common';
import { Account, JournalEntry, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CompanyService } from '../../company/company.service';
import { PeriodsService } from '../periods/periods.service';
import { Money } from '../../common/money/money';
import {
  ClosedPeriodError,
  ClosedYearError,
  InvalidAccountError,
  NotFoundDomainError,
  SegregationOfDutiesError,
  ValidationFailedError,
} from '../../common/errors/domain-errors';
import { PostEntryInput, PostLineInput } from './posting.types';
import { assertBalanced } from './assert-balanced';
import { ExtendedPrismaClient } from '../../common/prisma/soft-delete.extension';
import { MetricsService } from '../../metrics/metrics.service';
import { nextSequenceNumber, SqlTx } from '../../common/db/sequence';
import { buildDocRef } from '../../common/db/doc-ref';

/** The interactive-transaction view of the soft-delete-extended client — what the
 *  `$transaction(async (tx) => …)` callback receives. Shared so document services
 *  can compose journal posting into their own transactions. */
export type LedgerTx = Omit<
  ExtendedPrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends' | '$use'
>;

/** Module-private mint key — external code cannot import it, so it cannot
 *  satisfy the token constructors' first parameter. */
const PROTOCOL_MINT = Symbol('posting.protocol.mint');

/** The original posted entry (with lines) a reversal is built from. */
export type OriginalEntry = JournalEntry & {
  lines: {
    lineNo: number;
    accountId: string;
    debit: Prisma.Decimal;
    credit: Prisma.Decimal;
    description: string | null;
  }[];
};

/** Phase-one result for a post. Minted only by PostingService.preparePosting;
 *  required by createPostedEntryInTx so a post cannot skip preparation. */
export class PreparedPosting {
  constructor(
    mint: typeof PROTOCOL_MINT,
    readonly input: PostEntryInput,
    readonly postedBy: string,
    readonly periodId: string,
    readonly fiscalYear: number,
  ) {
    if (mint !== PROTOCOL_MINT) throw new Error('PreparedPosting is internal');
  }
}

/** Phase-one result for a reversal. Carries allowClosedYear so it is specified
 *  exactly once (not duplicated across prepare + write). Minted only by
 *  PostingService.prepareReversal; required by reverseInTx. */
export class PreparedReversal {
  constructor(
    mint: typeof PROTOCOL_MINT,
    readonly original: OriginalEntry,
    readonly reversedBy: string,
    readonly periodId: string,
    readonly fiscalYear: number,
    readonly reversalDate: Date,
    readonly allowClosedYear: boolean,
  ) {
    if (mint !== PROTOCOL_MINT) throw new Error('PreparedReversal is internal');
  }
}

@Injectable()
export class PostingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly company: CompanyService,
    private readonly periods: PeriodsService,
    private readonly metrics: MetricsService,
  ) {}

  async post(input: PostEntryInput, postedBy: string): Promise<JournalEntry> {
    const prepared = await this.preparePosting(input, postedBy);
    return this.prisma.client.$transaction((tx) =>
      this.createPostedEntryInTx(tx, prepared),
    );
  }

  /** Pre-transaction validation shared by direct posts and document posting.
   *  Runs the balance, SoD, open-period, and postable-account checks (all reads
   *  stay OUT of the write transaction to avoid pool contention under concurrency)
   *  and returns the resolved period + fiscal year. */
  async preparePosting(
    input: PostEntryInput,
    postedBy: string,
  ): Promise<PreparedPosting> {
    assertBalanced(input.lines);
    if (
      await this.company.isSegregationViolation({
        sourceType: input.sourceType,
        createdBy: input.createdBy,
        postedBy,
      })
    ) {
      throw new SegregationOfDutiesError(
        'The poster must differ from the entry creator',
        { createdBy: input.createdBy },
      );
    }
    // NOTE: period + account checks are intentionally pre-transaction. For this
    // single-company, low-concurrency phase the TOCTOU window (period closing /
    // account deactivating between check and write) is acceptable; move these
    // inside the $transaction (with FOR SHARE on the period) if concurrency grows.
    const { periodId, fiscalYear } = await this.assertPostableDate(input.date);
    await this.assertPostableAccounts(input.lines);
    return new PreparedPosting(
      PROTOCOL_MINT,
      input,
      postedBy,
      periodId,
      fiscalYear,
    );
  }

  /** Read-only date postability check (open period + year not closed), shared by
   *  preparePosting and the journal preview so the two can never drift. Plain
   *  reads only — no locks; the in-tx guard remains the authoritative check. */
  async assertPostableDate(
    date: Date,
  ): Promise<{ periodId: string; fiscalYear: number }> {
    const period = await this.periods.findOpenPeriodForDate(date);
    if (!period) {
      throw new ClosedPeriodError(
        'No open accounting period contains this date',
        { date: date.toISOString().slice(0, 10) },
      );
    }
    const fiscalYear = await this.company.fiscalYearFor(date);
    const closedYear = await this.prisma.client.yearEndClosing.findFirst({
      where: { fiscalYear, status: 'CLOSED' },
    });
    if (closedYear) {
      throw new ClosedYearError(
        'Fiscal year is closed; reopen it before posting',
        { fiscalYear },
      );
    }
    return { periodId: period.id, fiscalYear };
  }

  /** Assigns the gapless JE number and writes the (already-validated, balanced)
   *  entry within a caller-provided transaction. */
  async createPostedEntryInTx(
    tx: LedgerTx,
    prepared: PreparedPosting,
  ): Promise<JournalEntry> {
    const { input, postedBy, periodId, fiscalYear } = prepared;
    const { entryNumber, entryRef } = await this.stampPostedInTx(
      tx,
      periodId,
      fiscalYear,
    );
    return tx.journalEntry.create({
      data: {
        entryNumber,
        entryRef,
        fiscalYear,
        date: input.date,
        periodId,
        description: input.description,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        status: 'POSTED',
        createdBy: input.createdBy,
        postedBy,
        postedAt: new Date(),
        lines: {
          // Normalize to exactly 4dp at the trust boundary so the stored value
          // is the same one assertBalanced validated (PostingService is the
          // only writer of posted lines, and non-DTO callers reach here too).
          create: input.lines.map((l, i) => ({
            lineNo: i + 1,
            accountId: l.accountId,
            debit: Money.of(l.debit ?? '0').toPersistence(),
            credit: Money.of(l.credit ?? '0').toPersistence(),
            description: l.description,
          })),
        },
      },
    });
  }

  /** The in-transaction posted-entry choke point: re-assert the period/year is still
   *  postable (TOCTOU guard), assign the gapless JE number + ref, and count the entry.
   *  Every posted entry — a fresh create (createPostedEntryInTx), a draft promotion
   *  (postDraft), and a reversal (reverseInTx) — routes through here, so the guard, the
   *  numbering, and the metric live in exactly one place. `allowClosedYear` is passed
   *  through to the guard (reversal/void on reopen sets it). The metric increments inside
   *  the tx; a rare rollback after this point over-counts by 1 — acceptable for a
   *  throughput metric. */
  private async stampPostedInTx(
    tx: LedgerTx,
    periodId: string,
    fiscalYear: number,
    opts: { allowClosedYear?: boolean } = {},
  ): Promise<{ entryNumber: number; entryRef: string }> {
    await this.assertPostablePeriodInTx(tx, periodId, fiscalYear, opts);
    const entryNumber = await this.nextNumber(tx, fiscalYear);
    const entryRef = this.buildEntryRef(fiscalYear, entryNumber);
    this.metrics.incLedgerEntriesPosted();
    return { entryNumber, entryRef };
  }

  /** Authoritative in-transaction TOCTOU guard. Serializes against a concurrent
   *  period/year close: shared advisory lock on the fiscal year (close holds the
   *  exclusive one) + re-check year_end_closings; FOR SHARE on the period row
   *  (periods.close takes the conflicting exclusive lock) + re-check OPEN. Must be
   *  the FIRST statement in every posted-entry write path. */
  private async assertPostablePeriodInTx(
    tx: LedgerTx,
    periodId: string,
    fiscalYear: number,
    opts: { allowClosedYear?: boolean } = {},
  ): Promise<void> {
    if (!opts.allowClosedYear) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${fiscalYear})`;
      // Plain read (no FOR SHARE): the advisory lock above — not a row lock — is
      // the serializer here, because the year_end_closings row may not exist
      // before the first close. Do NOT "tidy" this into FOR SHARE; it would lock
      // nothing for a never-closed year and reopen the year-close TOCTOU.
      const yr = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM year_end_closings WHERE fiscal_year = ${fiscalYear}`;
      if (yr.length > 0 && yr[0].status === 'CLOSED') {
        throw new ClosedYearError(
          'Fiscal year is closed; reopen it before posting',
          { fiscalYear },
        );
      }
    }
    const p = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM accounting_periods WHERE id = ${periodId} FOR SHARE`;
    if (p.length === 0 || p[0].status !== 'OPEN') {
      throw new ValidationFailedError(
        'No open accounting period contains this date',
        { periodId },
      );
    }
  }

  async reverse(
    entryId: string,
    reversedBy: string,
    date?: Date,
  ): Promise<JournalEntry> {
    const prepared = await this.prepareReversal(entryId, reversedBy, date);
    try {
      return await this.prisma.client.$transaction((tx) =>
        this.reverseInTx(tx, prepared),
      );
    } catch (err) {
      // The unique on reversal_of_id means a concurrent/retried reverse of the
      // same entry loses the race — map it to a clean domain error, not a 500.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ValidationFailedError('Entry has already been reversed', {
          entryId,
        });
      }
      throw err;
    }
  }

  /** Pre-transaction validation for a reversal: loads the original (with lines),
   *  asserts it is POSTED, resolves the open period + fiscal year for the
   *  reversal date (defaults to the original's date). All reads stay out of the
   *  write transaction. */
  async prepareReversal(
    entryId: string,
    reversedBy: string,
    date?: Date,
    opts: { allowClosedYear?: boolean } = {},
  ): Promise<PreparedReversal> {
    const original = await this.prisma.client.journalEntry.findUnique({
      where: { id: entryId },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (!original)
      throw new NotFoundDomainError('Journal entry not found', { entryId });
    if (original.status !== 'POSTED') {
      throw new ValidationFailedError('Only a POSTED entry can be reversed', {
        entryId,
        status: original.status,
      });
    }
    const reversalDate = date ?? original.date;
    const period = await this.periods.findOpenPeriodForDate(reversalDate);
    if (!period) {
      throw new ClosedPeriodError('No open period for the reversal date', {
        date: reversalDate.toISOString().slice(0, 10),
      });
    }
    const fiscalYear = await this.company.fiscalYearFor(reversalDate);
    // Same year-lock as preparePosting/postDraft: a reversal (or document void)
    // must not write a POSTED entry into a year that has been closed. reopen()
    // legitimately reverses the closing entry while the year is still CLOSED, so
    // it passes allowClosedYear to bypass this guard.
    if (!opts.allowClosedYear) {
      const closedYear = await this.prisma.client.yearEndClosing.findFirst({
        where: { fiscalYear, status: 'CLOSED' },
      });
      if (closedYear) {
        throw new ClosedYearError(
          'Fiscal year is closed; reopen it before reversing',
          { fiscalYear },
        );
      }
    }
    return new PreparedReversal(
      PROTOCOL_MINT,
      original,
      reversedBy,
      period.id,
      fiscalYear,
      reversalDate,
      opts.allowClosedYear ?? false,
    );
  }

  /** Writes the reversal entry (debit/credit swapped) and marks the original
   *  REVERSED within a caller-provided transaction. `reversalDate` is the date
   *  `prepareReversal` resolved the period + fiscal year from, so the entry's
   *  date always agrees with its period. */
  async reverseInTx(
    tx: LedgerTx,
    prepared: PreparedReversal,
  ): Promise<JournalEntry> {
    const {
      original,
      reversedBy,
      periodId,
      fiscalYear,
      reversalDate,
      allowClosedYear,
    } = prepared;
    const { entryNumber, entryRef } = await this.stampPostedInTx(
      tx,
      periodId,
      fiscalYear,
      { allowClosedYear },
    );
    const reversal = await tx.journalEntry.create({
      data: {
        entryNumber,
        entryRef,
        fiscalYear,
        date: reversalDate,
        periodId,
        description: `Reversal of ${original.entryRef}`,
        sourceType: 'REVERSAL',
        reversalOfId: original.id,
        status: 'POSTED',
        createdBy: reversedBy,
        postedBy: reversedBy,
        postedAt: new Date(),
        lines: {
          create: original.lines.map((l) => ({
            lineNo: l.lineNo,
            accountId: l.accountId,
            debit: l.credit, // swap debit/credit
            credit: l.debit,
            description: l.description,
          })),
        },
      },
    });
    await tx.journalEntry.update({
      where: { id: original.id },
      data: { status: 'REVERSED', reversedById: reversal.id },
    });
    return reversal;
  }

  async postDraft(draftId: string, postedBy: string): Promise<JournalEntry> {
    const draft = await this.prisma.client.journalEntry.findUnique({
      where: { id: draftId },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (!draft)
      throw new NotFoundDomainError('Journal entry not found', { id: draftId });
    if (draft.status !== 'DRAFT') {
      throw new ValidationFailedError('Entry is not a draft', {
        id: draftId,
        status: draft.status,
      });
    }
    const lines = draft.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.debit.toString(),
      credit: l.credit.toString(),
    }));
    assertBalanced(lines);

    if (
      await this.company.isSegregationViolation({
        sourceType: draft.sourceType,
        createdBy: draft.createdBy,
        postedBy,
      })
    ) {
      throw new SegregationOfDutiesError(
        'The poster must differ from the entry creator',
        {
          createdBy: draft.createdBy,
        },
      );
    }
    const period = await this.periods.findOpenPeriodForDate(draft.date);
    if (!period) {
      throw new ClosedPeriodError(
        'No open accounting period contains this date',
        {
          date: draft.date.toISOString().slice(0, 10),
        },
      );
    }
    await this.assertPostableAccounts(lines);
    const fiscalYear = await this.company.fiscalYearFor(draft.date);
    // Same year-lock as preparePosting: a draft created while the year was open
    // must not be postable into it once the year has been closed.
    const closedYear = await this.prisma.client.yearEndClosing.findFirst({
      where: { fiscalYear, status: 'CLOSED' },
    });
    if (closedYear) {
      throw new ClosedYearError(
        'Fiscal year is closed; reopen it before posting',
        { fiscalYear },
      );
    }

    return this.prisma.client.$transaction(async (tx) => {
      // Lock the draft row and re-check status BEFORE consuming a number, so a
      // concurrent/retried postDraft of the same draft can't burn a gapless
      // number (and can't resurrect a soft-deleted draft).
      const locked = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM journal_entries
        WHERE id = ${draftId} AND deleted_at IS NULL FOR UPDATE`;
      if (locked.length === 0 || locked[0].status !== 'DRAFT') {
        throw new ValidationFailedError('Entry is no longer a draft', {
          id: draftId,
        });
      }
      const { entryNumber, entryRef } = await this.stampPostedInTx(
        tx,
        period.id,
        fiscalYear,
      );
      return tx.journalEntry.update({
        where: { id: draftId },
        data: {
          entryNumber,
          entryRef,
          fiscalYear,
          periodId: period.id,
          status: 'POSTED',
          postedBy,
          postedAt: new Date(),
        },
      });
    });
  }

  /** Human-readable posted-entry reference, e.g. JE/2026/000123. */
  private buildEntryRef(fiscalYear: number, entryNumber: number): string {
    return buildDocRef('JE', fiscalYear, entryNumber);
  }

  /** Lock-and-increment the per-fiscal-year counter; gapless because it lives in the tx. */
  private nextNumber(tx: SqlTx, fiscalYear: number): Promise<number> {
    return nextSequenceNumber(tx, 'journal_sequences', {
      fiscal_year: fiscalYear,
    });
  }

  /** Validate every id is an existing, postable, active account and return the
   *  accounts keyed by id. The single source of postable-account validation: the
   *  post path asserts through it; the preview reuses the returned map to enrich
   *  journal lines with code/name (one fetch, one rule set). */
  async resolvePostableAccounts(ids: string[]): Promise<Map<string, Account>> {
    const unique = [...new Set(ids)];
    const accounts = await this.prisma.client.account.findMany({
      where: { id: { in: unique } },
    });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    for (const id of unique) {
      const a = byId.get(id);
      if (!a)
        throw new InvalidAccountError('Account not found', { accountId: id });
      if (!a.isPostable)
        throw new InvalidAccountError(
          'Account is not postable (header account)',
          {
            accountId: id,
          },
        );
      if (!a.isActive)
        throw new InvalidAccountError('Account is inactive', { accountId: id });
    }
    return byId;
  }

  private async assertPostableAccounts(lines: PostLineInput[]): Promise<void> {
    await this.resolvePostableAccounts(lines.map((l) => l.accountId));
  }
}
