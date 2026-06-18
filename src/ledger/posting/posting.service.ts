import { Injectable } from '@nestjs/common';
import { JournalEntry, Prisma } from '@prisma/client';
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
import { RawTx } from '../../common/db/raw-tx';
import { buildDocRef } from '../../common/db/doc-ref';
import { fiscalYearForDate } from '../../common/dates/fiscal-year';

/** The interactive-transaction view of the soft-delete-extended client — what the
 *  `$transaction(async (tx) => …)` callback receives. Shared so document services
 *  can compose journal posting into their own transactions. */
export type LedgerTx = Omit<
  ExtendedPrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends' | '$use'
>;

@Injectable()
export class PostingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly company: CompanyService,
    private readonly periods: PeriodsService,
    private readonly metrics: MetricsService,
  ) {}

  async post(input: PostEntryInput, postedBy: string): Promise<JournalEntry> {
    const { periodId, fiscalYear } = await this.preparePosting(input, postedBy);
    return this.prisma.client.$transaction((tx) =>
      this.createPostedEntryInTx(tx, input, postedBy, periodId, fiscalYear),
    );
  }

  /** Pre-transaction validation shared by direct posts and document posting.
   *  Runs the balance, SoD, open-period, and postable-account checks (all reads
   *  stay OUT of the write transaction to avoid pool contention under concurrency)
   *  and returns the resolved period + fiscal year. */
  async preparePosting(
    input: PostEntryInput,
    postedBy: string,
  ): Promise<{ periodId: string; fiscalYear: number }> {
    assertBalanced(input.lines);
    const settings = await this.company.get();
    if (
      settings.segregationOfDutiesEnabled &&
      input.sourceType === 'MANUAL' &&
      postedBy === input.createdBy
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
    const period = await this.periods.findOpenPeriodForDate(input.date);
    if (!period) {
      throw new ClosedPeriodError(
        'No open accounting period contains this date',
        { date: input.date.toISOString().slice(0, 10) },
      );
    }
    await this.assertPostableAccounts(input.lines);
    const fiscalYear = this.fiscalYearFor(
      input.date,
      settings.fiscalYearStartMonth,
    );
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
    input: PostEntryInput,
    postedBy: string,
    periodId: string,
    fiscalYear: number,
  ): Promise<JournalEntry> {
    await this.assertPostablePeriodInTx(tx, periodId, fiscalYear);
    const entryNumber = await this.nextNumber(tx, fiscalYear);
    const entryRef = this.buildEntryRef(fiscalYear, entryNumber);
    const entry = await tx.journalEntry.create({
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
    // Central choke point for every posted entry (manual, invoice, bill, payment,
    // close). A rare tx rollback after this point over-counts by 1 — acceptable
    // for a throughput metric.
    this.metrics.incLedgerEntriesPosted();
    return entry;
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
    const { original, periodId, fiscalYear, reversalDate } =
      await this.prepareReversal(entryId, date);
    try {
      return await this.prisma.client.$transaction((tx) =>
        this.reverseInTx(
          tx,
          original,
          reversedBy,
          periodId,
          fiscalYear,
          reversalDate,
        ),
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
    date?: Date,
    opts: { allowClosedYear?: boolean } = {},
  ): Promise<{
    original: JournalEntry & {
      lines: {
        lineNo: number;
        accountId: string;
        debit: Prisma.Decimal;
        credit: Prisma.Decimal;
        description: string | null;
      }[];
    };
    periodId: string;
    fiscalYear: number;
    reversalDate: Date;
  }> {
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
    const settings = await this.company.get();
    const fiscalYear = this.fiscalYearFor(
      reversalDate,
      settings.fiscalYearStartMonth,
    );
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
    return { original, periodId: period.id, fiscalYear, reversalDate };
  }

  /** Writes the reversal entry (debit/credit swapped) and marks the original
   *  REVERSED within a caller-provided transaction. `reversalDate` is the date
   *  `prepareReversal` resolved the period + fiscal year from, so the entry's
   *  date always agrees with its period. */
  async reverseInTx(
    tx: LedgerTx,
    original: Awaited<
      ReturnType<PostingService['prepareReversal']>
    >['original'],
    reversedBy: string,
    periodId: string,
    fiscalYear: number,
    reversalDate: Date,
    opts: { allowClosedYear?: boolean } = {},
  ): Promise<JournalEntry> {
    await this.assertPostablePeriodInTx(tx, periodId, fiscalYear, opts);
    const entryNumber = await this.nextNumber(tx, fiscalYear);
    const entryRef = this.buildEntryRef(fiscalYear, entryNumber);
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

    const settings = await this.company.get();
    if (
      settings.segregationOfDutiesEnabled &&
      draft.sourceType === 'MANUAL' &&
      postedBy === draft.createdBy
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
    const fiscalYear = this.fiscalYearFor(
      draft.date,
      settings.fiscalYearStartMonth,
    );
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
      await this.assertPostablePeriodInTx(tx, period.id, fiscalYear);
      const entryNumber = await this.nextNumber(tx, fiscalYear);
      const entryRef = this.buildEntryRef(fiscalYear, entryNumber);
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
  private async nextNumber(tx: RawTx, fiscalYear: number): Promise<number> {
    await tx.$executeRaw`INSERT INTO journal_sequences (fiscal_year, next_number, updated_at)
      VALUES (${fiscalYear}, 1, now()) ON CONFLICT (fiscal_year) DO NOTHING`;
    const rows = await tx.$queryRaw<{ next_number: number }[]>`
      SELECT next_number FROM journal_sequences WHERE fiscal_year = ${fiscalYear} FOR UPDATE`;
    const current = rows[0].next_number;
    await tx.$executeRaw`UPDATE journal_sequences SET next_number = ${current + 1}, updated_at = now()
      WHERE fiscal_year = ${fiscalYear}`;
    return current;
  }

  private async assertPostableAccounts(lines: PostLineInput[]): Promise<void> {
    const ids = [...new Set(lines.map((l) => l.accountId))];
    const accounts = await this.prisma.client.account.findMany({
      where: { id: { in: ids } },
    });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    for (const id of ids) {
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
  }

  /** Fiscal year that a date falls into, given the configured start month. */
  fiscalYearFor(date: Date, startMonth: number): number {
    return fiscalYearForDate(date, startMonth);
  }
}
