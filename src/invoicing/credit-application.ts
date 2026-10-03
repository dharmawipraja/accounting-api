import { Injectable } from '@nestjs/common';
import { DocumentStatus, Prisma } from '@prisma/client';
import { assertNotAfterToday } from '../common/dates/not-after-today';
import { PrismaService } from '../common/prisma/prisma.service';
import type { LedgerTx } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import { lockLiveRow } from '../common/db/lock-live-row';
import {
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';
import {
  POSTING_TX_OPTIONS,
  PostingService,
  PreparedPosting,
} from '../ledger/posting/posting.service';
import { DocumentLifecycleService } from '../ledger/document-lifecycle.service';
import { findControlAccountId } from './document-helpers';
import {
  assertCashAccount,
  assertPaymentCashAccountPostable,
} from './document-account-rules';
import { lockLivePartnerForShare } from './partner-lock';
import { cap } from './document-presenter';
import {
  AllocationInput,
  PaymentTarget,
  assertPartnerInTx,
  buildPaymentLines,
  checkAllocations,
  settleAllInTx,
  toAllocationInput,
  unwindInTx,
} from './payment-targets';

/**
 * The credit engine shared by payments (their advance) and credit/debit notes
 * (their excess): apply unapplied credit onto documents, refund it in cash,
 * and reverse either. Holder rules, locks and the unapplied re-check live
 * here so both holders use the same code.
 */
@Injectable()
export class CreditApplicationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
    private readonly lifecycle: DocumentLifecycleService,
  ) {}

  /** Move part of a POSTED credit holder's unapplied amount (a payment's
   *  advance, or a credit/debit note's excess) onto invoices / bills of the
   *  same partner, dated `date` (on/after the holder and each document). One
   *  journal entry and one application row per allocation — Dr Uang Muka
   *  Pelanggan / Cr AR, or Dr AP / Cr Uang Muka Pembelian — through the
   *  guarded posting path. The entry's creator is the holder's creator and its
   *  poster the applier, so with SoD on the person who recorded the holder
   *  cannot also apply it (403), like posting it.
   *  Lock order (same as post/void): holder FOR UPDATE → partner FOR SHARE →
   *  each document FOR UPDATE (id order) → the ledger chain (year advisory →
   *  period → accounts → journal sequence). The unapplied balance is
   *  re-checked under the holder lock, so concurrent applies can't jointly
   *  over-apply (the loser gets the same 422). */
  async applyCredit(
    source: CreditSource,
    holder: CreditHolder,
    date: Date,
    allocations: AllocationInput[],
    appliedBy: string,
  ): Promise<void> {
    const { id } = holder;
    assertCreditUsable(source, holder, date, 'application');
    const target = source.target;
    const total = await checkAllocations(
      this.prisma.client,
      target,
      holder.partnerId,
      date,
      allocations,
    );
    assertWithinUnapplied(
      source,
      id,
      holder.unappliedAmount,
      total,
      'application',
    );
    const [advanceId, controlId] = await Promise.all([
      findControlAccountId(this.prisma, target.advanceRole),
      findControlAccountId(this.prisma, target.controlRole),
    ]);
    const prepared: PreparedPosting[] = [];
    for (const a of allocations)
      prepared.push(
        await this.posting.preparePosting(
          {
            date,
            description: `Application of ${source.noun} ${holder.ref ?? id}`,
            sourceType: source.sourceType,
            sourceId: id,
            createdBy: holder.createdBy,
            lines: buildPaymentLines(
              target,
              advanceId,
              controlId,
              Money.of(a.amount).toPersistence(),
            ),
          },
          appliedBy,
        ),
      );

    await this.prisma.transaction(async (tx) => {
      await lockHolderWithinUnapplied(tx, source, id, total, 'application');
      await assertPartnerInTx(tx, holder.partnerId, target);
      await settleAllInTx(tx, target, allocations, holder.partnerId, date);
      for (const [i, a] of allocations.entries()) {
        const entry = await this.posting.createPostedEntryInTx(tx, prepared[i]);
        await tx.paymentApplication.create({
          data: {
            [source.holderField]: id,
            salesInvoiceId: a.salesInvoiceId,
            purchaseBillId: a.purchaseBillId,
            amount: Money.of(a.amount).toPersistence(),
            date,
            journalEntryId: entry.id,
            createdBy: appliedBy,
          },
        });
      }
      await adjustUnapplied(tx, source, id, Money.zero().subtract(total));
    }, POSTING_TX_OPTIONS);
  }

  /** Pay part of a POSTED credit holder's unapplied amount back in cash — a
   *  customer refund (Dr Uang Muka Pelanggan / Cr cash) or a vendor refund
   *  received (Dr cash / Cr Uang Muka Pembelian), through the guarded posting
   *  path. Stored as a payment_applications row whose target is the CASH-role
   *  account (`cashAccountId`), so it shares the application rules: same SoD
   *  (entry creator = holder creator, poster = refunder), same partner rule,
   *  same lock order (holder FOR UPDATE → partner FOR SHARE → ledger chain)
   *  and the same unapplied re-check under the holder lock — a concurrent
   *  apply and refund can't jointly overdraw the credit. Date on/after the
   *  holder's, not after today (WIB), in an open period. */
  async refundCredit(
    source: CreditSource,
    holder: CreditHolder,
    refund: CreditRefundInput,
    refundedBy: string,
  ): Promise<void> {
    const { id } = holder;
    const { date, cashAccountId } = refund;
    assertCreditUsable(source, holder, date, 'refund');
    assertNotAfterToday(date, 'Refund date cannot be in the future');
    const amount = Money.of(refund.amount);
    if (amount.isZero() || amount.isNegative())
      throw new ValidationFailedError('Refund amount must be positive', { id });
    assertWithinUnapplied(source, id, holder.unappliedAmount, amount, 'refund');
    await assertPaymentCashAccountPostable(
      this.posting,
      this.prisma.client,
      cashAccountId,
    );
    const advanceId = await findControlAccountId(
      this.prisma,
      source.target.advanceRole,
    );
    // The advance account takes the cash slot and the real cash account the
    // counter slot: Dr advance / Cr cash (receipt side), Dr cash / Cr advance
    // (disbursement side) — the reverse of how the credit came in.
    const prepared = await this.posting.preparePosting(
      {
        date,
        description:
          refund.description ?? `Refund of ${source.noun} ${holder.ref ?? id}`,
        sourceType: source.sourceType,
        sourceId: id,
        createdBy: holder.createdBy,
        lines: buildPaymentLines(
          source.target,
          advanceId,
          cashAccountId,
          amount.toPersistence(),
        ),
      },
      refundedBy,
    );
    await this.prisma.transaction(async (tx) => {
      await lockHolderWithinUnapplied(tx, source, id, amount, 'refund');
      await assertPartnerInTx(tx, holder.partnerId, source.target);
      await assertCashAccount(tx, cashAccountId);
      const entry = await this.posting.createPostedEntryInTx(tx, prepared);
      await tx.paymentApplication.create({
        data: {
          [source.holderField]: id,
          cashAccountId,
          amount: amount.toPersistence(),
          date,
          journalEntryId: entry.id,
          createdBy: refundedBy,
        },
      });
      await adjustUnapplied(tx, source, id, Money.zero().subtract(amount));
    }, POSTING_TX_OPTIONS);
  }

  /** Undo one application (or, `kind: 'refund'`, one refund): reverse its
   *  journal entry (dated `date`, default the application date; never after
   *  today (WIB) or before the application date), give the amount back to the
   *  document's outstanding (applications only) and to the holder's unapplied
   *  balance. Same locks and partner rule as a payment void (holder FOR
   *  UPDATE → partner FOR SHARE → document FOR UPDATE). */
  async reverseCreditApplication(
    source: CreditSource,
    holder: CreditHolder,
    applicationId: string,
    reversedBy: string,
    date?: Date,
    kind: CreditUse = 'application',
  ): Promise<void> {
    const { id } = holder;
    const what = `${cap(source.noun)} ${kind}`;
    const idKey = `${kind}Id`;
    const application = await this.prisma.client.paymentApplication.findFirst({
      where: {
        id: applicationId,
        [source.holderField]: id,
        cashAccountId: kind === 'refund' ? { not: null } : null,
      },
    });
    if (!application)
      throw new NotFoundDomainError(`${what} not found`, {
        id,
        [idKey]: applicationId,
      });
    if (application.reversedOn)
      throw new ValidationFailedError(`${what} was already reversed`, {
        id,
        [idKey]: applicationId,
      });
    if (date)
      assertNotAfterToday(date, 'Reversal date cannot be in the future', {
        originalDate: application.date,
      });
    const reversedOn = date ?? application.date;
    const target = source.target;
    await this.lifecycle.reverseWithGuard({
      id,
      journalEntryId: application.journalEntryId,
      reversedBy,
      reversalDate: reversedOn,
      alreadyReversedMessage: `${what} was already reversed`,
      notPostedMessage: `${cap(source.noun)} is not posted`,
      lock: (tx) =>
        lockLiveRow<{ status: string }>(tx, source.table, id, 'status'),
      applyInTx: async (tx) => {
        const [row] = await tx.$queryRaw<{ reversed_on: Date | null }[]>`
          SELECT reversed_on FROM payment_applications WHERE id = ${applicationId}`;
        if (row.reversed_on)
          throw new ValidationFailedError(`${what} was already reversed`, {
            id,
            [idKey]: applicationId,
          });
        if (!(await lockLivePartnerForShare(tx, holder.partnerId)))
          throw new ValidationFailedError(
            `Cannot reverse ${kind === 'refund' ? 'a refund' : 'an application'} whose partner has been deleted`,
            { id, partnerId: holder.partnerId, reason: 'PARTNER_DELETED' },
          );
        // A refund settled no document; only an application reopens one.
        if (!application.cashAccountId)
          await unwindInTx(tx, target, toAllocationInput(application));
        await tx.paymentApplication.update({
          where: { id: applicationId },
          data: { reversedOn, reversedBy },
        });
        await adjustUnapplied(tx, source, id, Money.of(application.amount));
      },
    });
  }
}

/** Something whose POSTED unapplied credit can be applied to documents: a
 *  payment (its advance) or a credit/debit note (its excess). */
export interface CreditSource {
  noun: string; // 'payment' | 'credit note' | 'debit note'
  /** Constant literal, never user input (safe for Prisma.raw). */
  table: 'payments' | 'sales_credit_notes' | 'purchase_debit_notes';
  /** The PaymentApplication field naming the holder. */
  holderField: 'paymentId' | 'salesCreditNoteId' | 'purchaseDebitNoteId';
  /** 422 details key for the holder's date. */
  dateKey: string;
  sourceType: 'PAYMENT' | 'SALES_CREDIT_NOTE' | 'PURCHASE_DEBIT_NOTE';
  target: PaymentTarget;
}

/** The holder row as applyCredit / reverseCreditApplication read it. */
export interface CreditHolder {
  id: string;
  status: DocumentStatus;
  date: Date;
  partnerId: string;
  createdBy: string;
  ref: string | null;
  unappliedAmount: string;
}

export function creditHolderOf(r: {
  id: string;
  status: DocumentStatus;
  date: Date;
  partnerId: string;
  createdBy: string;
  ref: string | null;
  unappliedAmount: Prisma.Decimal;
}): CreditHolder {
  return {
    id: r.id,
    status: r.status,
    date: r.date,
    partnerId: r.partnerId,
    createdBy: r.createdBy,
    ref: r.ref,
    unappliedAmount: r.unappliedAmount.toString(),
  };
}

/** Add `delta` (negative to consume) to the holder's unapplied_amount; the
 *  table's CHECK keeps it within [0, …]. */
async function adjustUnapplied(
  tx: LedgerTx,
  source: CreditSource,
  id: string,
  delta: Money,
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    UPDATE ${Prisma.raw(source.table)}
    SET unapplied_amount = unapplied_amount + ${delta.toPersistence()}::numeric,
        updated_at = now()
    WHERE id = ${id}`);
}

/** What a holder's unapplied credit is used for: applied onto documents, or
 *  refunded in cash. */
export type CreditUse = 'application' | 'refund';

/** POST /…/:id/refunds body, as the service takes it. */
export interface CreditRefundInput {
  date: Date;
  amount: string;
  /** CASH-role account the money moves through. */
  cashAccountId: string;
  description?: string;
}

/** Pre-lock holder rules for an application / refund (pure): the holder is
 *  POSTED and `date` is on/after its date (422). */
export function assertCreditUsable(
  source: Pick<CreditSource, 'noun' | 'dateKey'>,
  holder: Pick<CreditHolder, 'id' | 'status' | 'date'>,
  date: Date,
  use: CreditUse,
): void {
  const { id } = holder;
  if (holder.status !== 'POSTED')
    throw new ValidationFailedError(
      `Only a POSTED ${source.noun} can be ${use === 'refund' ? 'refunded' : 'applied'}`,
      { id, status: holder.status },
    );
  if (date.getTime() < holder.date.getTime())
    throw new ValidationFailedError(
      `${cap(use)} date cannot be before the ${source.noun} date`,
      {
        id,
        date: date.toISOString().slice(0, 10),
        [source.dateKey]: holder.date.toISOString().slice(0, 10),
      },
    );
}

/** Lock the holder FOR UPDATE, then re-check it is still POSTED and that
 *  `total` fits its unapplied balance — the authoritative over-use guard
 *  every application and refund of the same holder serializes on. */
async function lockHolderWithinUnapplied(
  tx: LedgerTx,
  source: CreditSource,
  id: string,
  total: Money,
  use: CreditUse,
): Promise<void> {
  const locked = await lockLiveRow<{
    status: string;
    unapplied_amount: string;
  }>(
    tx,
    source.table,
    id,
    'status, unapplied_amount::text AS unapplied_amount',
  );
  if (!locked || locked.status !== 'POSTED')
    throw new ValidationFailedError(`${cap(source.noun)} is no longer posted`, {
      id,
    });
  assertWithinUnapplied(source, id, locked.unapplied_amount, total, use);
}

/** 422 when `requested` exceeds the holder's unapplied balance (pure). */
export function assertWithinUnapplied(
  source: Pick<CreditSource, 'noun'>,
  id: string,
  unappliedAmount: string,
  requested: Money,
  use: CreditUse,
): void {
  if (Money.of(unappliedAmount).subtract(requested).isNegative())
    throw new ValidationFailedError(
      `${cap(use)} exceeds the ${source.noun} unapplied amount`,
      {
        id,
        unappliedAmount: Money.of(unappliedAmount).toPersistence(),
        requested: requested.toPersistence(),
      },
    );
}

/** Void precondition of a credit holder (payment / note), read under its
 *  FOR UPDATE lock: no live application (422 HAS_APPLICATIONS — reverse them
 *  first), and the void date on/after every reversed application's reversal
 *  date (else the advance account would, for the days between, carry the
 *  reversed application's debit against a holder already voided). */
export async function assertNoLiveApplicationsInTx(
  tx: LedgerTx,
  source: Pick<CreditSource, 'noun' | 'holderField'>,
  id: string,
  voidedOn: Date,
): Promise<void> {
  const column = Prisma.raw(
    {
      paymentId: 'payment_id',
      salesCreditNoteId: 'sales_credit_note_id',
      purchaseDebitNoteId: 'purchase_debit_note_id',
    }[source.holderField],
  );
  const [r] = await tx.$queryRaw<
    { live: number; last_reversed_on: Date | null }[]
  >(Prisma.sql`
    SELECT count(*) FILTER (WHERE reversed_on IS NULL)::int AS live,
           max(reversed_on) AS last_reversed_on
    FROM payment_applications WHERE ${column} = ${id}`);
  if (r.live > 0)
    throw new ValidationFailedError(
      `Reverse this ${source.noun}'s applications and refunds before voiding it`,
      { id, reason: 'HAS_APPLICATIONS', applications: r.live },
    );
  if (r.last_reversed_on && r.last_reversed_on.getTime() > voidedOn.getTime())
    throw new ValidationFailedError(
      `Void date cannot be before the reversal date of an application of this ${source.noun}`,
      {
        id,
        date: voidedOn.toISOString().slice(0, 10),
        applicationReversedOn: r.last_reversed_on.toISOString().slice(0, 10),
      },
    );
}
