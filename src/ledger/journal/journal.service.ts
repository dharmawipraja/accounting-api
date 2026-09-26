import { Injectable } from '@nestjs/common';
import {
  JournalEntry,
  JournalSourceType,
  JournalStatus,
  Prisma,
} from '@prisma/client';
import { assertNotAfterToday } from '../../common/dates/not-after-today';
import { PrismaService } from '../../common/prisma/prisma.service';
import { trigramSearch } from '../../common/search/trigram-search';
import { listPaginated } from '../../common/pagination/paginated';
import { PostingService } from '../posting/posting.service';
import { DocumentLifecycleService } from '../document-lifecycle.service';
import { PostLineInput } from '../posting/posting.types';
import { accountPolicyFor } from '../posting/account-policy';
import { assertLinesOneSided } from '../posting/assert-balanced';
import { Money } from '../../common/money/money';
import {
  NotFoundDomainError,
  ValidationFailedError,
} from '../../common/errors/domain-errors';

/** Source types the generic `/journal-entries/:id/reverse` endpoint may reverse. */
const REVERSIBLE_HERE: ReadonlySet<JournalSourceType> = new Set([
  'MANUAL',
  'OPENING',
]);

export interface DraftInput {
  date: Date;
  description: string;
  lines: PostLineInput[];
  createdBy: string;
}

export interface JournalEntryListItem {
  id: string;
  entryRef: string | null;
  entryNumber: number | null;
  fiscalYear: number | null;
  date: string;
  description: string;
  status: JournalStatus;
  sourceType: JournalSourceType;
  sourceId: string | null;
  totalDebit: string;
  lineCount: number;
}

export interface JournalListFilter {
  q?: string;
  status?: JournalStatus;
  sourceType?: JournalSourceType;
  fiscalYear?: number;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}

@Injectable()
export class JournalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
    private readonly lifecycle: DocumentLifecycleService,
  ) {}

  async createDraft(input: DraftInput): Promise<JournalEntry> {
    // Per-line shape is final at create (a two-sided, empty or zero line can
    // never post); only the debit == credit totals may still be unbalanced.
    assertLinesOneSided(input.lines);
    // Same account rules and errors as post (unknown/deleted/header/inactive
    // → 422 INVALID_ACCOUNT; AR/AP control → 422 {accountId, role}), so a bad
    // id never reaches the FK (which would surface as a 409).
    await this.posting.resolvePostableAccounts(
      input.lines.map((l) => l.accountId),
      accountPolicyFor('MANUAL'),
    );
    // Transaction so an idempotent create marks its key committed atomically
    // with the insert (see PrismaService.transaction).
    return this.prisma.transaction((tx) =>
      tx.journalEntry.create({
        data: {
          date: input.date,
          description: input.description,
          sourceType: 'MANUAL',
          status: 'DRAFT',
          createdBy: input.createdBy,
          lines: {
            create: input.lines.map((l, i) => ({
              lineNo: i + 1,
              accountId: l.accountId,
              debit: l.debit ?? '0',
              credit: l.credit ?? '0',
              description: l.description,
            })),
          },
        },
      }),
    );
  }

  async getById(id: string): Promise<JournalEntry> {
    const entry = await this.prisma.client.journalEntry.findFirst({
      where: { id },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (!entry)
      throw new NotFoundDomainError('Journal entry not found', { id });
    return entry;
  }

  async deleteDraft(id: string, deletedBy: string): Promise<void> {
    return this.lifecycle.softDeleteDraft(
      this.prisma.client.journalEntry,
      id,
      deletedBy,
      'entry',
    );
  }

  async postDraft(id: string, postedBy: string): Promise<JournalEntry> {
    return this.posting.postDraft(id, postedBy);
  }

  /** Generic reversal endpoint. Only free-standing entries (MANUAL, OPENING)
   *  may be reversed here: document-owned entries (invoice/bill/payment) must be
   *  voided through their document so the AR/AP subledger stays in step with
   *  the control account, and CLOSING entries are undone by reopening the year. */
  async reverse(
    id: string,
    reversedBy: string,
    date?: Date,
  ): Promise<JournalEntry> {
    const entry = await this.prisma.client.journalEntry.findFirst({
      where: { id },
      select: { sourceType: true, date: true },
    });
    if (!entry)
      throw new NotFoundDomainError('Journal entry not found', { entryId: id });
    if (!REVERSIBLE_HERE.has(entry.sourceType)) {
      throw new ValidationFailedError(
        'Only MANUAL or OPENING entries can be reversed here; void the source document instead',
        { entryId: id, sourceType: entry.sourceType },
      );
    }
    // An explicit reversal date may not be after max(today (WIB), the
    // entry's own date) — 422 { date, today[, originalDate] }: a future-dated
    // entry may be reversed on its own date, like the no-body reversal.
    // (Year-end reopen reverses through PostingService directly, on the
    // closing entry's own date.)
    if (date)
      assertNotAfterToday(date, 'Reversal date cannot be in the future', {
        originalDate: entry.date,
      });
    return this.posting.reverse(id, reversedBy, date);
  }

  /** Direct create-and-post (used when Segregation of Duties is off). */
  async createAndPost(
    input: DraftInput,
    postedBy: string,
  ): Promise<JournalEntry> {
    return this.posting.post(
      {
        date: input.date,
        description: input.description,
        sourceType: 'MANUAL',
        createdBy: input.createdBy,
        lines: input.lines,
      },
      postedBy,
    );
  }

  /**
   * Post opening balances, auto-plugging the imbalance into the Opening Balance
   * Equity account (3-9000) so the entry always balances. If the supplied
   * balances already net to zero, no plug line is added. Opening balances are
   * balance-sheet positions only: a REVENUE/EXPENSE account is a 422
   * (`reason: 'PNL_IN_OPENING'`) enforced by OPENING_POLICY inside
   * PostingService.post — mid-year YTD P&L goes in as a MANUAL journal.
   */
  async postOpeningBalances(
    date: Date,
    balances: PostLineInput[],
    postedBy: string,
  ): Promise<JournalEntry> {
    let debit = Money.zero();
    let credit = Money.zero();
    for (const b of balances) {
      debit = debit.add(Money.of(b.debit ?? '0'));
      credit = credit.add(Money.of(b.credit ?? '0'));
    }

    const equity = await this.prisma.client.account.findFirst({
      where: { role: 'OPENING_BALANCE_EQUITY' },
    });
    if (!equity) {
      throw new ValidationFailedError(
        'Opening Balance Equity account missing from chart',
      );
    }

    const diff = debit.subtract(credit); // debits>credits -> plug is a credit to equity
    const lines: PostLineInput[] = [...balances];
    // A zero plug would violate the line CHECK (debit > 0 OR credit > 0), so
    // only add the plug when the balances do not already net to zero.
    if (!diff.isZero()) {
      lines.push(
        diff.isNegative()
          ? { accountId: equity.id, debit: diff.multiply('-1').toString() }
          : { accountId: equity.id, credit: diff.toString() },
      );
    }

    return this.posting.post(
      {
        date,
        description: 'Opening balances',
        sourceType: 'OPENING',
        createdBy: postedBy,
        lines,
      },
      postedBy,
    );
  }

  async list(filter: JournalListFilter): Promise<{
    data: JournalEntryListItem[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const where: Prisma.JournalEntryWhereInput = {
      status: filter.status,
      sourceType: filter.sourceType,
      fiscalYear: filter.fiscalYear,
      date:
        filter.from || filter.to
          ? { gte: filter.from, lte: filter.to }
          : undefined,
    };
    return listPaginated({
      q: filter.q,
      limit: filter.limit,
      offset: filter.offset,
      present: (r: JournalEntry & { lines: { debit: Prisma.Decimal }[] }) =>
        this.present(r),
      search: ({ term, limit, offset }) => {
        const filters: Prisma.Sql[] = [];
        if (filter.status)
          filters.push(Prisma.sql`t.status::text = ${filter.status}`);
        if (filter.sourceType)
          filters.push(Prisma.sql`t.source_type::text = ${filter.sourceType}`);
        if (filter.fiscalYear)
          filters.push(Prisma.sql`t.fiscal_year = ${filter.fiscalYear}`);
        if (filter.from) filters.push(Prisma.sql`t.date >= ${filter.from}`);
        if (filter.to) filters.push(Prisma.sql`t.date <= ${filter.to}`);
        return trigramSearch(this.prisma, {
          table: 'journal_entries',
          alias: 't',
          ownColumns: ['entry_ref', 'description'],
          filters,
          q: term,
          limit,
          offset,
        });
      },
      hydrate: (ids) =>
        this.prisma.client.journalEntry.findMany({
          where: { id: { in: ids } },
          include: { lines: { select: { debit: true } } },
        }),
      page: ({ limit, offset }) =>
        Promise.all([
          this.prisma.client.journalEntry.findMany({
            where,
            include: { lines: { select: { debit: true } } },
            orderBy: [{ date: 'desc' }, { entryNumber: 'desc' }],
            take: limit,
            skip: offset,
          }),
          this.prisma.client.journalEntry.count({ where }),
        ]).then(([rows, total]) => ({ rows, total })),
    });
  }

  private present(
    e: JournalEntry & { lines: { debit: Prisma.Decimal }[] },
  ): JournalEntryListItem {
    const total = e.lines.reduce(
      (s, l) => s.add(Money.of(l.debit)),
      Money.zero(),
    );
    return {
      id: e.id,
      entryRef: e.entryRef,
      entryNumber: e.entryNumber,
      fiscalYear: e.fiscalYear,
      date: e.date.toISOString().slice(0, 10),
      description: e.description,
      status: e.status,
      sourceType: e.sourceType,
      sourceId: e.sourceId,
      totalDebit: total.toPersistence(),
      lineCount: e.lines.length,
    };
  }
}
