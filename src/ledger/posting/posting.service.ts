import { Injectable } from '@nestjs/common';
import { JournalEntry, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CompanyService } from '../../company/company.service';
import { PeriodsService } from '../periods/periods.service';
import { Money } from '../../common/money/money';
import {
  ClosedPeriodError,
  InvalidAccountError,
  NotFoundDomainError,
  SegregationOfDutiesError,
  UnbalancedEntryError,
  ValidationFailedError,
} from '../../common/errors/domain-errors';
import { PostEntryInput, PostLineInput } from './posting.types';
import { ExtendedPrismaClient } from '../../common/prisma/soft-delete.extension';

/**
 * The subset of the interactive-tx client that {@link PostingService.nextNumber}
 * needs. Typed structurally (only the two raw-SQL methods) because the
 * soft-delete-extended client's `$transaction` callback `tx` is not nominally
 * assignable to `Prisma.TransactionClient`, but is structurally compatible here.
 */
type RawTxClient = {
  $executeRaw: (
    query: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<number>;
  $queryRaw: <T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<T>;
};

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
    this.assertBalanced(input.lines);
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
    const entryNumber = await this.nextNumber(tx, fiscalYear);
    const entryRef = this.buildEntryRef(fiscalYear, entryNumber);
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
  ): Promise<JournalEntry> {
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
    this.assertBalanced(lines);

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
    return `JE/${fiscalYear}/${String(entryNumber).padStart(6, '0')}`;
  }

  /** Lock-and-increment the per-fiscal-year counter; gapless because it lives in the tx. */
  private async nextNumber(
    tx: RawTxClient,
    fiscalYear: number,
  ): Promise<number> {
    await tx.$executeRaw`INSERT INTO journal_sequences (fiscal_year, next_number, updated_at)
      VALUES (${fiscalYear}, 1, now()) ON CONFLICT (fiscal_year) DO NOTHING`;
    const rows = await tx.$queryRaw<{ next_number: number }[]>`
      SELECT next_number FROM journal_sequences WHERE fiscal_year = ${fiscalYear} FOR UPDATE`;
    const current = rows[0].next_number;
    await tx.$executeRaw`UPDATE journal_sequences SET next_number = ${current + 1}, updated_at = now()
      WHERE fiscal_year = ${fiscalYear}`;
    return current;
  }

  private assertBalanced(lines: PostLineInput[]): void {
    if (lines.length < 2) {
      throw new UnbalancedEntryError('An entry needs at least two lines');
    }
    let debit = Money.zero();
    let credit = Money.zero();
    for (const l of lines) {
      const d = Money.of(l.debit ?? '0');
      const c = Money.of(l.credit ?? '0');
      const dPos = !d.isZero();
      const cPos = !c.isZero();
      if (dPos === cPos) {
        throw new UnbalancedEntryError(
          'Each line must have exactly one of debit or credit > 0',
        );
      }
      debit = debit.add(d);
      credit = credit.add(c);
    }
    if (!debit.equals(credit)) {
      throw new UnbalancedEntryError('Total debits must equal total credits', {
        debit: debit.toString(),
        credit: credit.toString(),
      });
    }
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
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    return m >= startMonth ? y : y - 1;
  }
}
