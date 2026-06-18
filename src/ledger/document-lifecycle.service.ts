import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { PostingService, LedgerTx } from './posting/posting.service';
import { ValidationFailedError } from '../common/errors/domain-errors';

type SoftDeletableModel = {
  updateMany: (args: {
    where: { id: string; status: 'DRAFT'; deletedAt: null };
    data: { deletedAt: Date; deletedBy: string };
  }) => Promise<{ count: number }>;
};

@Injectable()
export class DocumentLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
  ) {}

  /**
   * Soft-deletes a DRAFT document. The `status: 'DRAFT', deletedAt: null`
   * predicate is the optimistic concurrency guard: a concurrent post flips
   * status so count===0 and we 422. Mirrors the per-service deleteDraft().
   */
  async softDeleteDraft(
    model: SoftDeletableModel,
    id: string,
    deletedBy: string,
    noun: string,
  ): Promise<void> {
    const res = await model.updateMany({
      where: { id, status: 'DRAFT', deletedAt: null },
      data: { deletedAt: new Date(), deletedBy },
    });
    if (res.count !== 1) {
      throw new ValidationFailedError(`Only a DRAFT ${noun} can be deleted`, { id });
    }
  }

  /**
   * Reverses a posted document's journal entry with a FOR UPDATE race guard.
   * Mirrors the existing void(): prepareReversal runs OUTSIDE the tx (it does
   * its own period/closed-year resolution); lock()/applyInTx()/reverseInTx()
   * run inside. A lost reversal race (Prisma P2002 on the unique reversal_of_id)
   * becomes a 422 ValidationFailedError(alreadyReversedMessage). The caller
   * keeps its own preconditions (status POSTED, payments/allocations checks)
   * and passes the document's journalEntryId in.
   */
  async reverseWithGuard<TLocked extends { status: string }>(opts: {
    id: string;
    journalEntryId: string;
    reversedBy: string;
    reversalDate?: Date;
    alreadyReversedMessage: string;
    notPostedMessage: string;
    /** SELECT ... FOR UPDATE the document row (deleted_at IS NULL) and return it, or undefined. */
    lock: (tx: LedgerTx) => Promise<TLocked | undefined>;
    /** Per-document in-tx side effects BEFORE reverseInTx (e.g. set status VOID; unwind allocations). */
    applyInTx: (tx: LedgerTx, locked: TLocked) => Promise<void>;
  }): Promise<void> {
    const prepared = await this.posting.prepareReversal(
      opts.journalEntryId,
      opts.reversalDate,
    );
    try {
      await this.prisma.client.$transaction(async (tx) => {
        const ltx = tx as unknown as LedgerTx;
        const locked = await opts.lock(ltx);
        if (!locked || locked.status !== 'POSTED') {
          throw new ValidationFailedError(opts.notPostedMessage, { id: opts.id });
        }
        await opts.applyInTx(ltx, locked);
        await this.posting.reverseInTx(
          ltx,
          prepared.original,
          opts.reversedBy,
          prepared.periodId,
          prepared.fiscalYear,
          prepared.reversalDate,
        );
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ValidationFailedError(opts.alreadyReversedMessage, { id: opts.id });
      }
      throw err;
    }
  }
}
