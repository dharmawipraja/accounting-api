import { Injectable } from '@nestjs/common';
import {
  JournalEntry,
  JournalSourceType,
  JournalStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PostingService } from '../posting/posting.service';
import { AccountsService } from '../accounts/accounts.service';
import { PostLineInput } from '../posting/posting.types';
import { Money } from '../../common/money/money';
import { OPENING_BALANCE_EQUITY_CODE } from '../accounts/chart-of-accounts.seed';
import {
  NotFoundDomainError,
  ValidationFailedError,
} from '../../common/errors/domain-errors';

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
    private readonly accounts: AccountsService,
  ) {}

  async createDraft(input: DraftInput): Promise<JournalEntry> {
    return this.prisma.client.journalEntry.create({
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
    });
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
    const entry = await this.getById(id);
    if (entry.status !== 'DRAFT') {
      throw new ValidationFailedError('Only a DRAFT entry can be deleted', {
        id,
        status: entry.status,
      });
    }
    // Conditional soft-delete: only if it is STILL a draft, so a post racing in
    // between the check above and here cannot have a POSTED entry soft-deleted.
    const res = await this.prisma.client.journalEntry.updateMany({
      where: { id, status: 'DRAFT', deletedAt: null },
      data: { deletedAt: new Date(), deletedBy },
    });
    if (res.count !== 1) {
      throw new ValidationFailedError('Only a DRAFT entry can be deleted', {
        id,
      });
    }
  }

  async postDraft(id: string, postedBy: string): Promise<JournalEntry> {
    return this.posting.postDraft(id, postedBy);
  }

  async reverse(id: string, reversedBy: string): Promise<JournalEntry> {
    return this.posting.reverse(id, reversedBy);
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
   * balances already net to zero, no plug line is added.
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

    const equity = (await this.accounts.list()).find(
      (a) => a.code === OPENING_BALANCE_EQUITY_CODE,
    );
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
    const [rows, total] = await Promise.all([
      this.prisma.client.journalEntry.findMany({
        where,
        include: { lines: { select: { debit: true } } },
        orderBy: [{ date: 'desc' }, { entryNumber: 'desc' }],
        take: filter.limit,
        skip: filter.offset,
      }),
      this.prisma.client.journalEntry.count({ where }),
    ]);
    return {
      data: rows.map((r) => this.present(r)),
      total,
      limit: filter.limit,
      offset: filter.offset,
    };
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
