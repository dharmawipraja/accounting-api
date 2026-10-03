import { Injectable } from '@nestjs/common';
import { Account, JournalEntry, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CompanyService } from '../../company/company.service';
import { PeriodsService } from '../periods/periods.service';
import { Money } from '../../common/money/money';
import {
  ClosedPeriodError,
  ClosedYearError,
  ConflictDomainError,
  InvalidAccountError,
  NotFoundDomainError,
  SegregationOfDutiesError,
  ValidationFailedError,
} from '../../common/errors/domain-errors';
import { PostEntryInput, PostLineInput } from './posting.types';
import { assertBalanced } from './assert-balanced';
import { MetricsService } from '../../metrics/metrics.service';
import { nextSequenceNumber, SqlTx } from '../../common/db/sequence';
import { buildDocRef } from '../../common/db/doc-ref';
import { lockLiveRow } from '../../common/db/lock-live-row';
import {
  AccountPolicy,
  FORBIDDEN_ROLE_MESSAGE,
  UNRESTRICTED_POLICY,
  accountPolicyFor,
  findForbiddenRole,
  findForbiddenType,
} from './account-policy';

import type { LedgerTx } from '../../common/prisma/prisma.service';
import { assertNotAfterToday } from '../../common/dates/not-after-today';

/** Explicit interactive-tx bounds for the posting writes (direct post,
 *  postDraft, reversal): wait up to 5s for a pool connection, run up to 20s
 *  (lock waits behind a year close / period close / concurrent post). A breach
 *  surfaces as Prisma P2028 → 409 CONFLICT { retryable: true } (rolled back). */
export const POSTING_TX_OPTIONS = { maxWait: 5000, timeout: 20000 } as const;

/** Transaction-scoped advisory lock serializing OPENING posts, so two
 *  concurrent opening posts can't both pass the one-live-opening-entry check.
 *  Distinct from the other 71_00x_001 keys and the fiscal-year keys (see the
 *  domain-glossary.md lock table). */
export const OPENING_LOCK_KEY = 71_004_001;

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
    return this.prisma.transaction(
      (tx) => this.createPostedEntryInTx(tx, prepared),
      POSTING_TX_OPTIONS,
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
    // Period + account checks run here pre-transaction for early, cheap 4xx;
    // the authoritative re-checks happen inside the write tx (stampPostedInTx:
    // period FOR SHARE + year advisory lock, then accounts FOR SHARE).
    const { periodId, fiscalYear } = await this.assertPostableDate(input.date);
    await this.resolvePostableAccounts(
      input.lines.map((l) => l.accountId),
      accountPolicyFor(input.sourceType),
    );
    return new PreparedPosting(
      PROTOCOL_MINT,
      input,
      postedBy,
      periodId,
      fiscalYear,
    );
  }

  /** Date postability check (open period + year not closed), shared by
   *  preparePosting and the journal preview so the two can never drift. No
   *  locks; the in-tx guard remains the authoritative check. Not strictly
   *  read-only: resolving the period may auto-generate the CURRENT or NEXT
   *  fiscal year's periods (idempotent) when none exist — so a preview with a
   *  `date` can create them too, exactly as the real post would. */
  async assertPostableDate(
    date: Date,
  ): Promise<{ periodId: string; fiscalYear: number }> {
    const period = await this.periods.resolveOpenPeriodForDate(date);
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
    if (input.sourceType === 'OPENING')
      await this.assertOpeningAllowedInTx(tx, input.lines);
    const { entryNumber, entryRef } = await this.stampPostedInTx(
      tx,
      periodId,
      fiscalYear,
      {
        accounts: {
          ids: input.lines.map((l) => l.accountId),
          policy: accountPolicyFor(input.sourceType),
        },
      },
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

  /** Opening-balance guard rails, checked under OPENING_LOCK_KEY — taken
   *  first, ahead of stampPostedInTx's year advisory → period → accounts →
   *  sequence chain (like a document's row lock); nothing else takes it, so
   *  it cannot deadlock against close/reopen or other posts.
   *  1. At most ONE live opening entry: another POSTED OPENING entry → 409
   *     `{ existingEntryId, entryRef }`; reversing it re-opens the slot.
   *  2. AR/AP control lines only before the first sales invoice, purchase bill
   *     or (non-opening) payment (any status; soft-deleted drafts don't
   *     count; an opening credit touches no control account): after that a
   *     lump-sum control balance would have no subledger document behind it →
   *     422 `{ accountId, role, reason: 'DOCUMENTS_EXIST' }`.
   *  ponytail: (2) does not lock the document tables — a document created
   *  concurrently with the go-live opening post can still interleave; the
   *  window is the go-live moment only. */
  private async assertOpeningAllowedInTx(
    tx: LedgerTx,
    lines: PostLineInput[],
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${OPENING_LOCK_KEY})`;
    const [live] = await tx.$queryRaw<
      { id: string; entry_ref: string | null }[]
    >`
      SELECT id, entry_ref FROM journal_entries
      WHERE source_type = 'OPENING' AND status = 'POSTED' AND deleted_at IS NULL
      ORDER BY posted_at LIMIT 1`;
    if (live)
      throw new ConflictDomainError(
        'Opening balances are already posted; reverse the existing opening entry before entering new ones',
        { existingEntryId: live.id, entryRef: live.entry_ref },
      );
    const ids = [...new Set(lines.map((l) => l.accountId))];
    const [control] = await tx.$queryRaw<{ id: string; role: string }[]>`
      SELECT id, role::text AS role FROM accounts
      WHERE id = ANY(${ids}::text[])
        AND role IN ('AR_CONTROL', 'AP_CONTROL')
      ORDER BY id LIMIT 1`;
    if (!control) return;
    const [{ exists }] = await tx.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM sales_invoices WHERE deleted_at IS NULL)
          OR EXISTS (SELECT 1 FROM purchase_bills WHERE deleted_at IS NULL)
          OR EXISTS (SELECT 1 FROM payments
                     WHERE deleted_at IS NULL AND NOT opening) AS exists`;
    if (exists)
      throw new ValidationFailedError(
        'AR/AP control accounts can only take opening balances before the first sales invoice, purchase bill or payment; enter open items as documents instead',
        {
          accountId: control.id,
          role: control.role,
          reason: 'DOCUMENTS_EXIST',
        },
      );
  }

  /** The in-transaction posted-entry choke point: re-assert the period/year is still
   *  postable (TOCTOU guard), assign the gapless JE number + ref, and count the entry.
   *  Every posted entry — a fresh create (createPostedEntryInTx), a draft promotion
   *  (postDraft), and a reversal (reverseInTx) — routes through here, so the guard, the
   *  numbering, and the metric live in exactly one place. `allowClosedYear` is passed
   *  through to the guard (reversal/void on reopen sets it). The metric increments inside
   *  the tx; a rare rollback after this point over-counts by 1 — acceptable for a
   *  throughput metric. `accounts` (fresh posts and draft promotions; reversals
   *  mirror an already-posted entry and skip it) re-validates the line accounts
   *  under FOR SHARE. Lock order here: year advisory lock → period row → accounts
   *  (sorted by id) → journal sequence. Document and payment posts take their own
   *  locks BEFORE calling in: the document row FOR UPDATE, the document sequence
   *  (document_sequences) and, for payments, each allocated target document FOR
   *  UPDATE (id order) — all ahead of the year advisory lock. */
  private async stampPostedInTx(
    tx: LedgerTx,
    periodId: string,
    fiscalYear: number,
    opts: {
      allowClosedYear?: boolean;
      accounts?: { ids: string[]; policy: AccountPolicy };
    } = {},
  ): Promise<{ entryNumber: number; entryRef: string }> {
    await this.assertPostablePeriodInTx(tx, periodId, fiscalYear, opts);
    if (opts.accounts)
      await this.assertPostableAccountsInTx(
        tx,
        opts.accounts.ids,
        opts.accounts.policy,
      );
    const entryNumber = await this.nextNumber(tx, fiscalYear);
    const entryRef = this.buildEntryRef(fiscalYear, entryNumber);
    this.metrics.incLedgerEntriesPosted();
    return { entryNumber, entryRef };
  }

  /** Authoritative in-transaction TOCTOU guard. Serializes against a concurrent
   *  period/year close: shared advisory lock on the fiscal year (close holds the
   *  exclusive one) + re-check year_end_closings; FOR SHARE on the period row
   *  (periods.close takes the conflicting exclusive lock) + re-check OPEN. It is
   *  the first ledger lock of every posted-entry write path, but NOT always the
   *  first statement of the tx: document and payment posts first lock the
   *  document row(s) FOR UPDATE and take the document number (document_sequences)
   *  — see stampPostedInTx. That order cannot deadlock against close/reopen:
   *  year close and period close/reopen never lock documents or
   *  document_sequences, so the locks both sides take are the year advisory
   *  lock, the period row and — after this guard, when a year close posts its
   *  closing entry or a reopen its reversal — the journal-entry sequence row (nextNumber), always
   *  acquired in that same order. */
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
      // Same error as the pre-tx check (409 CLOSED_PERIOD): the client sees
      // one contract whether the period closed before or during the request.
      throw new ClosedPeriodError(
        'No open accounting period contains this date',
        { periodId },
      );
    }
  }

  async reverse(
    entryId: string,
    reversedBy: string,
    date?: Date,
    opts: { futureDateCeiling?: boolean } = {},
  ): Promise<JournalEntry> {
    const prepared = await this.prepareReversal(
      entryId,
      reversedBy,
      date,
      opts,
    );
    try {
      return await this.prisma.transaction(
        (tx) => this.reverseInTx(tx, prepared),
        POSTING_TX_OPTIONS,
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
   *  reversal date (defaults to the original's date; must not precede it). All
   *  reads stay out of the write transaction. No sourceType guard here: the
   *  year-end reopen reverses CLOSING entries through this method — the
   *  MANUAL/OPENING restriction lives in JournalService.reverse.
   *  `futureDateCeiling` (the generic reversal endpoint): an EXPLICIT `date`
   *  may not be after max(today (WIB), the entry's own date) — checked here,
   *  after the POSTED check, against the entry just read (not a caller's
   *  pre-read), 422 `{ date, today[, originalDate] }`. */
  async prepareReversal(
    entryId: string,
    reversedBy: string,
    date?: Date,
    opts: { allowClosedYear?: boolean; futureDateCeiling?: boolean } = {},
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
    if (date && opts.futureDateCeiling)
      assertNotAfterToday(date, 'Reversal date cannot be in the future', {
        originalDate: original.date,
      });
    const reversalDate = date ?? original.date;
    // A reversal can be dated later (e.g. into an open period when the
    // original's is closed) but never before the entry it reverses.
    if (reversalDate.getTime() < original.date.getTime()) {
      throw new ValidationFailedError(
        'Reversal date cannot be before the original entry date',
        {
          entryId,
          date: reversalDate.toISOString().slice(0, 10),
          originalDate: original.date.toISOString().slice(0, 10),
        },
      );
    }
    const period = await this.periods.resolveOpenPeriodForDate(reversalDate);
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
    // Same open-period + year-lock checks as preparePosting: a draft created
    // while the year was open must not be postable once it has been closed.
    const { periodId, fiscalYear } = await this.assertPostableDate(draft.date);
    await this.resolvePostableAccounts(
      lines.map((l) => l.accountId),
      accountPolicyFor(draft.sourceType),
    );

    return this.prisma.transaction(async (tx) => {
      // Lock the draft row and re-check status BEFORE consuming a number, so a
      // concurrent/retried postDraft of the same draft can't burn a gapless
      // number (and can't resurrect a soft-deleted draft).
      const locked = await lockLiveRow<{ status: string }>(
        tx,
        'journal_entries',
        draftId,
        'status',
      );
      if (!locked || locked.status !== 'DRAFT') {
        throw new ValidationFailedError('Entry is no longer a draft', {
          id: draftId,
        });
      }
      // Post-time re-validation under the draft lock: the lines being promoted
      // are the ones in the DB now, so the stamp re-checks THEIR accounts
      // (postable/active/not deleted + source-type policy, FOR SHARE) — this
      // also catches drafts written before the policy guard existed.
      const current = await tx.journalLine.findMany({
        where: { journalEntryId: draftId },
        orderBy: { lineNo: 'asc' },
        select: { accountId: true },
      });
      const { entryNumber, entryRef } = await this.stampPostedInTx(
        tx,
        periodId,
        fiscalYear,
        {
          accounts: {
            ids: current.map((l) => l.accountId),
            policy: accountPolicyFor(draft.sourceType),
          },
        },
      );
      return tx.journalEntry.update({
        where: { id: draftId },
        data: {
          entryNumber,
          entryRef,
          fiscalYear,
          periodId,
          status: 'POSTED',
          postedBy,
          postedAt: new Date(),
        },
      });
    }, POSTING_TX_OPTIONS);
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
   *  journal lines with code/name (one fetch, one rule set). `db` defaults to
   *  the base client; a caller already inside a transaction (document draft
   *  PATCH) passes its tx so the read stays on that connection. A plain
   *  (unlocked) read: the post path re-checks under FOR SHARE. */
  async resolvePostableAccounts(
    ids: string[],
    policy: AccountPolicy = UNRESTRICTED_POLICY,
    db: LedgerTx = this.prisma.client,
  ): Promise<Map<string, Account>> {
    const unique = [...new Set(ids)];
    const accounts = await db.account.findMany({
      where: { id: { in: unique } },
    });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    this.assertAccountsValid(unique, byId, policy);
    return byId;
  }

  /** In-transaction re-check of the line accounts: lock them FOR SHARE (sorted
   *  by id, deterministic) so a concurrent deactivate/soft-delete (FOR UPDATE)
   *  serializes with this post, then re-apply the same rules as
   *  resolvePostableAccounts. Raw SQL on purpose: a soft-deleted row must be
   *  seen and reported as missing, and Prisma has no FOR SHARE. */
  private async assertPostableAccountsInTx(
    tx: LedgerTx,
    ids: string[],
    policy: AccountPolicy,
  ): Promise<void> {
    const unique = [...new Set(ids)].sort();
    if (unique.length === 0) return;
    const rows = await tx.$queryRaw<
      {
        id: string;
        is_postable: boolean;
        is_active: boolean;
        role: Account['role'];
        type: Account['type'];
      }[]
    >`
      SELECT id, is_postable, is_active, role, type FROM accounts
      WHERE id = ANY(${unique}::text[]) AND deleted_at IS NULL
      ORDER BY id FOR SHARE`;
    const byId = new Map(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          isPostable: r.is_postable,
          isActive: r.is_active,
          role: r.role,
          type: r.type,
        },
      ]),
    );
    this.assertAccountsValid(unique, byId, policy);
  }

  /** The postable-account rule set, shared by the pre-tx and in-tx checks:
   *  every id exists (live), is a postable leaf, is active (unless the policy
   *  allows inactive — CLOSING only), and its role and type are allowed by
   *  the source-type policy. */
  private assertAccountsValid(
    unique: string[],
    byId: Map<
      string,
      {
        id: string;
        isPostable: boolean;
        isActive: boolean;
        role: Account['role'];
        type: Account['type'];
      }
    >,
    policy: AccountPolicy,
  ): void {
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
      if (!a.isActive && !policy.allowInactive)
        throw new InvalidAccountError('Account is inactive', { accountId: id });
    }
    const typeHit = findForbiddenType(
      unique.map((id) => byId.get(id)!),
      policy,
    );
    if (typeHit)
      throw new ValidationFailedError(policy.forbiddenTypes!.message, typeHit);
    this.throwIfForbiddenRole(
      unique.map((id) => byId.get(id)!),
      policy,
    );
  }

  private throwIfForbiddenRole(
    accounts: { id: string; role: Account['role'] }[],
    policy: AccountPolicy,
  ): void {
    const hit = findForbiddenRole(accounts, policy);
    if (!hit) return;
    const rule = policy.forbiddenRoleRule;
    throw rule
      ? new ValidationFailedError(rule.message, { ...hit, reason: rule.reason })
      : new ValidationFailedError(FORBIDDEN_ROLE_MESSAGE, hit);
  }
}
