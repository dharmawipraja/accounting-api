import { Injectable } from '@nestjs/common';
import { JournalEntry } from '@prisma/client';
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

  async postDraft(
    id: string,
    postedBy: string,
    idempotencyKey?: string,
  ): Promise<JournalEntry> {
    const existing = await this.lookupIdempotent(idempotencyKey);
    if (existing) return existing;
    const posted = await this.posting.postDraft(id, postedBy);
    await this.recordIdempotent(idempotencyKey, 'postDraft', posted.id);
    return posted;
  }

  async reverse(
    id: string,
    reversedBy: string,
    idempotencyKey?: string,
  ): Promise<JournalEntry> {
    const existing = await this.lookupIdempotent(idempotencyKey);
    if (existing) return existing;
    const reversal = await this.posting.reverse(id, reversedBy);
    await this.recordIdempotent(idempotencyKey, 'reverse', reversal.id);
    return reversal;
  }

  /** Direct create-and-post (used when Segregation of Duties is off). */
  async createAndPost(
    input: DraftInput,
    postedBy: string,
    idempotencyKey?: string,
  ): Promise<JournalEntry> {
    const existing = await this.lookupIdempotent(idempotencyKey);
    if (existing) return existing;
    const posted = await this.posting.post(
      {
        date: input.date,
        description: input.description,
        sourceType: 'MANUAL',
        createdBy: input.createdBy,
        lines: input.lines,
      },
      postedBy,
    );
    await this.recordIdempotent(idempotencyKey, 'createAndPost', posted.id);
    return posted;
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
    idempotencyKey?: string,
  ): Promise<JournalEntry> {
    const existing = await this.lookupIdempotent(idempotencyKey);
    if (existing) return existing;

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

    const posted = await this.posting.post(
      {
        date,
        description: 'Opening balances',
        sourceType: 'OPENING',
        createdBy: postedBy,
        lines,
      },
      postedBy,
    );
    await this.recordIdempotent(idempotencyKey, 'openingBalances', posted.id);
    return posted;
  }

  // ---- idempotency helpers ----
  private async lookupIdempotent(key?: string): Promise<JournalEntry | null> {
    if (!key) return null;
    const record = await this.prisma.client.idempotencyKey.findUnique({
      where: { key },
    });
    if (!record?.resultEntryId) return null;
    return this.prisma.client.journalEntry.findFirst({
      where: { id: record.resultEntryId },
    });
  }

  private async recordIdempotent(
    key: string | undefined,
    endpoint: string,
    entryId: string,
  ): Promise<void> {
    if (!key) return;
    await this.prisma.client.idempotencyKey.create({
      data: { key, endpoint, resultEntryId: entryId },
    });
  }
}
