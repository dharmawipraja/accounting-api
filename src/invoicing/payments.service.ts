import { Injectable } from '@nestjs/common';
import {
  DocumentStatus,
  Payment,
  PaymentDirection,
  Prisma,
} from '@prisma/client';
import { assertNotAfterToday } from '../common/dates/not-after-today';
import { PrismaService } from '../common/prisma/prisma.service';
import { trigramSearch } from '../common/search/trigram-search';
import { Money } from '../common/money/money';
import {
  POSTING_TX_OPTIONS,
  PostingService,
  PreparedPosting,
} from '../ledger/posting/posting.service';
import type { LedgerTx } from '../common/prisma/prisma.service';
import {
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';
import { BusinessPartnersService } from './business-partners.service';
import { listPaginated } from '../common/pagination/paginated';
import { serializeMoney } from '../common/money/serialize-money';
import {
  assertVoidDateNotBefore,
  findControlAccountId,
  nextDocumentNumber,
} from './document-helpers';
import { DocumentLifecycleService } from '../ledger/document-lifecycle.service';
import {
  assertCashAccount,
  assertPaymentCashAccountPostable,
} from './document-account-rules';
import { lockLivePartnerForShare } from './partner-lock';
import {
  AllocationInput,
  PAYMENT_TARGETS,
  PaymentTarget,
  loadTarget,
  settleInTx,
  unwindInTx,
  buildPaymentLines,
  inLockOrder,
  assertPaymentDateNotBefore,
  assertNoBackdatedOverAllocation,
} from './payment-targets';

/** A payment row with its allocations and applications eagerly loaded — what
 *  getById always returns. */
type PaymentWithAllocations = Prisma.PaymentGetPayload<{
  include: { allocations: true; applications: true };
}>;

const WITH_CHILDREN = {
  allocations: true,
  applications: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} as const satisfies Prisma.PaymentInclude;

export interface CreatePaymentInput {
  direction: PaymentDirection;
  partnerId: string;
  date: Date;
  cashAccountId: string;
  description?: string;
  /** Total; defaults to the allocation sum. The excess is an advance. */
  amount?: string;
  allocations: AllocationInput[];
  createdBy: string;
}

const toAllocationInput = (a: {
  salesInvoiceId: string | null;
  purchaseBillId: string | null;
  amount: Prisma.Decimal;
}): AllocationInput => ({
  salesInvoiceId: a.salesInvoiceId ?? undefined,
  purchaseBillId: a.purchaseBillId ?? undefined,
  amount: a.amount.toString(),
});

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly partners: BusinessPartnersService,
    private readonly posting: PostingService,
    private readonly lifecycle: DocumentLifecycleService,
  ) {}

  async createDraft(input: CreatePaymentInput): Promise<Payment> {
    const partner = await this.partners.findById(input.partnerId);
    if (!partner.isActive)
      throw new ValidationFailedError('Partner is inactive', {
        partnerId: input.partnerId,
      });
    const target = PAYMENT_TARGETS[input.direction];
    if (!partner[target.partnerFlag])
      throw new ValidationFailedError(target.partnerRequiredMessage, {
        partnerId: input.partnerId,
      });
    // Same cash-account checks, order and errors as preview / post: exists,
    // live, postable, active (422 INVALID_ACCOUNT { accountId }, the posting
    // path's own check under the PAYMENT policy), then the CASH role (422
    // VALIDATION_FAILED).
    await assertPaymentCashAccountPostable(
      this.posting,
      this.prisma.client,
      input.cashAccountId,
    );

    const allocated = await this.checkAllocations(
      target,
      input.partnerId,
      input.date,
      input.allocations,
    );
    // amount defaults to the allocation sum (a fully allocated payment); any
    // excess is the unapplied advance.
    const total =
      input.amount === undefined ? allocated : Money.of(input.amount);
    if (total.isZero())
      throw new ValidationFailedError(
        'A payment needs a positive amount or at least one allocation',
        {},
      );
    const unapplied = total.subtract(allocated);
    if (unapplied.isNegative())
      throw new ValidationFailedError('Allocations exceed the payment amount', {
        amount: total.toPersistence(),
        allocated: allocated.toPersistence(),
      });
    // Fail at create, not only at post, when the advance account is missing.
    if (!unapplied.isZero())
      await findControlAccountId(this.prisma, target.advanceRole);

    // Transaction so an idempotent create marks its key committed atomically
    // with the insert (see PrismaService.transaction). The partner is re-read
    // FOR SHARE first so a concurrent partner delete (FOR UPDATE) serializes
    // with this insert instead of orphaning a draft behind a deleted partner.
    return this.prisma.transaction(async (tx) => {
      await this.assertPartnerInTx(tx, input.partnerId, target);
      return tx.payment.create({
        data: {
          direction: input.direction,
          partnerId: input.partnerId,
          date: input.date,
          cashAccountId: input.cashAccountId,
          amount: total.toPersistence(),
          unappliedAmount: unapplied.toPersistence(),
          description: input.description,
          createdBy: input.createdBy,
          allocations: {
            create: input.allocations.map((a) => ({
              salesInvoiceId: a.salesInvoiceId,
              purchaseBillId: a.purchaseBillId,
              amount: a.amount,
            })),
          },
        },
        include: WITH_CHILDREN,
      });
    });
  }

  /** Create-time (and apply-time) allocation checks, no locks — each is
   *  re-done under the document FOR UPDATE lock by settleInTx: right document
   *  type, positive amount, same partner, POSTED, `date` on/after the
   *  document's, within its outstanding (net of earlier entries of this same
   *  list to that document), and the backdated-void rule. Returns the sum. */
  private async checkAllocations(
    target: PaymentTarget,
    partnerId: string,
    date: Date,
    allocations: readonly AllocationInput[],
  ): Promise<Money> {
    let total = Money.zero();
    const allocatedByDoc = new Map<string, Money>();
    for (const alloc of allocations) {
      const amt = Money.of(alloc.amount);
      if (amt.isZero() || amt.isNegative())
        throw new ValidationFailedError(
          'Allocation amount must be positive',
          {},
        );
      const targetRow = await loadTarget(this.prisma.client, target, alloc);
      if (targetRow.partnerId !== partnerId)
        throw new ValidationFailedError(
          'Allocated document belongs to another partner',
          { documentId: targetRow.id },
        );
      if (targetRow.status !== 'POSTED')
        throw new ValidationFailedError(
          'Can only allocate to a POSTED document',
          { documentId: targetRow.id, status: targetRow.status },
        );
      assertPaymentDateNotBefore(date, targetRow);
      // Outstanding net of what THIS list already allocated to the same
      // document, so two allocations to one invoice can't each pass in isolation.
      const alreadyAllocated = allocatedByDoc.get(targetRow.id) ?? Money.zero();
      const outstanding = Money.of(targetRow.total.toString())
        .subtract(Money.of(targetRow.amountPaid.toString()))
        .subtract(alreadyAllocated);
      // amt > outstanding  ⟺  (outstanding − amt) < 0
      if (outstanding.subtract(amt).isNegative()) {
        throw new ValidationFailedError(
          'Allocation exceeds the document outstanding',
          { documentId: targetRow.id },
        );
      }
      // Backdated-void pre-check (re-done under the document lock at post).
      await assertNoBackdatedOverAllocation(
        this.prisma.client,
        target,
        targetRow,
        date,
        alreadyAllocated.add(amt).toPersistence(),
      );
      allocatedByDoc.set(targetRow.id, alreadyAllocated.add(amt));
      total = total.add(amt);
    }
    return total;
  }

  async getById(id: string): Promise<PaymentWithAllocations> {
    const p = await this.prisma.client.payment.findFirst({
      where: { id },
      include: WITH_CHILDREN,
    });
    if (!p) throw new NotFoundDomainError('Payment not found', { id });
    return p;
  }

  async listPage(q: {
    q?: string;
    partnerId?: string;
    direction?: PaymentDirection;
    status?: DocumentStatus;
    unapplied?: 'true' | 'false';
    limit?: number;
    offset?: number;
  }): Promise<{
    data: ReturnType<PaymentsService['present']>[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const filters: Prisma.Sql[] = [];
    if (q.partnerId) filters.push(Prisma.sql`t.partner_id = ${q.partnerId}`);
    if (q.direction)
      filters.push(Prisma.sql`t.direction::text = ${q.direction}`);
    if (q.status) filters.push(Prisma.sql`t.status::text = ${q.status}`);
    // "Has open advance credit": POSTED with unapplied_amount > 0.
    const openCredit: Prisma.PaymentWhereInput = {
      status: 'POSTED',
      unappliedAmount: { gt: 0 },
    };
    if (q.unapplied === 'true')
      filters.push(Prisma.sql`t.status = 'POSTED' AND t.unapplied_amount > 0`);
    if (q.unapplied === 'false')
      filters.push(
        Prisma.sql`NOT (t.status = 'POSTED' AND t.unapplied_amount > 0)`,
      );
    const where: Prisma.PaymentWhereInput = {
      partnerId: q.partnerId,
      direction: q.direction,
      status: q.status,
      ...(q.unapplied === 'true' ? { AND: [openCredit] } : {}),
      ...(q.unapplied === 'false' ? { NOT: openCredit } : {}),
    };
    return listPaginated({
      q: q.q,
      limit: q.limit,
      offset: q.offset,
      present: (r: Payment) => this.present(r),
      search: ({ term, limit, offset }) =>
        trigramSearch(this.prisma, {
          table: 'payments',
          alias: 't',
          ownColumns: ['ref', 'description'],
          join: {
            table: 'business_partners',
            alias: 'p',
            onColumn: 'partner_id',
            columns: ['name', 'code'],
          },
          filters,
          q: term,
          limit,
          offset,
        }),
      hydrate: (ids) =>
        this.prisma.client.payment.findMany({ where: { id: { in: ids } } }),
      page: async ({ limit, offset }) => {
        const [rows, total] = await Promise.all([
          this.prisma.client.payment.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: limit,
            skip: offset,
          }),
          this.prisma.client.payment.count({ where }),
        ]);
        return { rows, total };
      },
    });
  }

  async deleteDraft(id: string, deletedBy: string): Promise<void> {
    return this.lifecycle.softDeleteDraft(
      this.prisma.client.payment,
      id,
      deletedBy,
      'payment',
    );
  }

  async post(id: string, postedBy: string): Promise<Payment> {
    const payment = await this.getById(id);
    if (payment.status !== 'DRAFT')
      throw new ValidationFailedError('Payment is not a draft', {
        id,
        status: payment.status,
      });
    const allocations = payment.allocations.map(toAllocationInput);
    const target = PAYMENT_TARGETS[payment.direction];
    const controlId = await findControlAccountId(
      this.prisma,
      target.controlRole,
    );
    const amount = Money.of(payment.amount.toString());
    // The unallocated part (fixed at create; drafts have no edit path) goes to
    // the advance account instead of AR/AP.
    const unapplied = Money.of(payment.unappliedAmount.toString());
    const advance = unapplied.isZero()
      ? undefined
      : {
          accountId: await findControlAccountId(
            this.prisma,
            target.advanceRole,
          ),
          amount: unapplied.toPersistence(),
        };

    const journalInput = {
      date: payment.date,
      description: payment.description ?? `Payment ${id}`,
      sourceType: 'PAYMENT' as const,
      sourceId: id,
      createdBy: payment.createdBy,
      lines: buildPaymentLines(
        target,
        payment.cashAccountId,
        controlId,
        amount.toPersistence(),
        advance,
      ),
    };
    const prepared = await this.posting.preparePosting(journalInput, postedBy);

    await this.prisma.transaction(async (tx) => {
      // Lock + re-check the payment is still a draft.
      const lockedP = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM payments WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
      if (lockedP.length === 0 || lockedP[0].status !== 'DRAFT')
        throw new ValidationFailedError('Payment is no longer a draft', {
          id,
        });
      // A draft payment has no edit path (create / delete / post only), so
      // the cashAccountId, amount and allocations read before this tx are
      // the locked row's; a concurrent delete fails the re-check above.
      // Post-time re-validation: the cash side must still be a CASH-role
      // account (catches drafts written before the rule existed).
      await assertCashAccount(tx, payment.cashAccountId);
      // The partner must still be live, active and carry the direction's
      // flag (customer for receipts, vendor for disbursements). FOR SHARE
      // serializes with a partner soft-delete (FOR UPDATE) / deactivation.
      await this.assertPartnerInTx(tx, payment.partnerId, target);

      // Lock each target document FOR UPDATE and re-verify outstanding (the
      // real over-allocation guard) and payment date >= document date — in
      // id order, so concurrent payments over overlapping documents can't
      // deadlock. settledBefore carries this payment's earlier allocations to
      // the same document into the backdated-void check.
      const settled = new Map<string, Money>();
      for (const a of inLockOrder(target, allocations)) {
        const docId = target.allocId(a)!;
        const before = settled.get(docId) ?? Money.zero();
        await settleInTx(
          tx,
          target,
          a,
          payment.partnerId,
          payment.date,
          before,
        );
        settled.set(docId, before.add(Money.of(a.amount)));
      }

      const { number, ref } = await nextDocumentNumber(
        tx,
        target.numberPrefix,
        prepared.fiscalYear,
      );
      const entry = await this.posting.createPostedEntryInTx(tx, prepared);
      await tx.payment.update({
        where: { id },
        data: {
          status: 'POSTED',
          number,
          ref,
          fiscalYear: prepared.fiscalYear,
          journalEntryId: entry.id,
          postedBy,
          postedAt: new Date(),
        },
      });
      // A concurrent post of the same invoice blocks here on the FOR UPDATE locks
      // above. Give it room to wait out the winner and reach its clean 409 instead
      // of hitting Prisma's 5s default and surfacing as a 500 under load.
    }, POSTING_TX_OPTIONS);
    return this.getById(id);
  }

  /** In-tx partner re-check for payment create and post (422 on failure). */
  private async assertPartnerInTx(
    tx: LedgerTx,
    partnerId: string,
    target: (typeof PAYMENT_TARGETS)[PaymentDirection],
  ): Promise<void> {
    const p = await lockLivePartnerForShare(tx, partnerId);
    if (!p || !p.isActive)
      throw new ValidationFailedError('Partner is inactive', { partnerId });
    const hasFlag = p[target.partnerFlag];
    if (!hasFlag)
      throw new ValidationFailedError(target.partnerRequiredMessage, {
        partnerId,
      });
  }

  async void(id: string, voidedBy: string, date?: Date): Promise<Payment> {
    const payment = await this.getById(id);
    if (payment.status !== 'POSTED')
      throw new ValidationFailedError('Only a POSTED payment can be voided', {
        id,
        status: payment.status,
      });
    // Void (reversal) date defaults to the payment date; a later date lets a
    // payment be voided after its own period has closed.
    const voidedOn = date ?? payment.date;
    // An explicit void date may not be after max(today (WIB), own date) —
    // 422 { date, today[, originalDate] }: a future-dated original may be
    // voided on its own date, like the no-body void.
    if (date)
      assertNotAfterToday(date, 'Void date cannot be in the future', {
        originalDate: payment.date,
      });
    assertVoidDateNotBefore(voidedOn, payment.date, id);
    const allocations = payment.allocations.map(toAllocationInput);
    await this.lifecycle.reverseWithGuard({
      id,
      journalEntryId: payment.journalEntryId!,
      reversedBy: voidedBy,
      reversalDate: voidedOn,
      alreadyReversedMessage: 'Payment journal entry was already reversed',
      notPostedMessage: 'Payment is not posted',
      lock: async (tx) => {
        const locked = await tx.$queryRaw<{ status: string }[]>`
          SELECT status FROM payments WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
        return locked[0];
      },
      applyInTx: async (tx) => {
        // Voiding reopens the allocated documents' balances; refuse when the
        // partner was soft-deleted (a fully settled partner may be deleted),
        // or the receivable/payable would reappear behind a partner nobody
        // can select. FOR SHARE serializes with a concurrent partner delete.
        // An inactive (not deleted) partner may still be voided against.
        if (!(await lockLivePartnerForShare(tx, payment.partnerId)))
          throw new ValidationFailedError(
            'Cannot void a payment whose partner has been deleted',
            { id, partnerId: payment.partnerId, reason: 'PARTNER_DELETED' },
          );
        // Void reverses only the payment's own journal (cash vs AR/AP +
        // advance). Later applications have their own journals, so they must
        // be reversed first — read under the payment FOR UPDATE lock, which
        // apply / reverse-application also take, so none can slip in.
        await assertNoLiveApplicationsInTx(tx, id, voidedOn);
        const target = PAYMENT_TARGETS[payment.direction];
        for (const a of inLockOrder(target, allocations)) {
          await unwindInTx(tx, target, a);
        }
        await tx.payment.update({
          where: { id },
          data: { status: 'VOID', voidedOn, unappliedAmount: 0 },
        });
      },
    });
    return this.getById(id);
  }

  /** Shape the API response. Money columns are normalized to 4dp strings (matching
   *  the ledger/invoice serialization convention) since Prisma's Decimal#toJSON
   *  strips trailing zeros. */
  present(
    payment: Payment & {
      allocations?: PaymentWithAllocations['allocations'];
      applications?: PaymentWithAllocations['applications'];
    },
  ): Payment {
    const { allocations, applications } = payment;
    return {
      ...serializeMoney(payment, ['amount', 'unappliedAmount']),
      ...(allocations
        ? {
            allocations: allocations.map((a) => serializeMoney(a, ['amount'])),
          }
        : {}),
      ...(applications
        ? {
            applications: applications.map((a) =>
              serializeMoney(a, ['amount']),
            ),
          }
        : {}),
    };
  }

  /** Move part of a POSTED payment's unapplied (advance) amount onto
   *  invoices (receipt) / bills (disbursement) of the same partner, dated
   *  `date` (on/after the payment and each document). One journal entry and
   *  one application row per allocation — Dr Uang Muka Pelanggan / Cr AR, or
   *  Dr AP / Cr Uang Muka Pembelian — through the guarded posting path.
   *  The entry's creator is the payment's creator and its poster the
   *  applier, so with SoD on the person who recorded the payment cannot also
   *  apply it (403), like posting it.
   *  Lock order (same as post/void): payment FOR UPDATE → partner FOR SHARE →
   *  each document FOR UPDATE (id order) → the ledger chain (year advisory →
   *  period → accounts → journal sequence). The unapplied balance is
   *  re-checked under the payment lock, so concurrent applies can't jointly
   *  over-apply (the loser gets the same 422). */
  async apply(
    id: string,
    date: Date,
    allocations: AllocationInput[],
    appliedBy: string,
  ): Promise<PaymentWithAllocations> {
    const payment = await this.getById(id);
    if (payment.status !== 'POSTED')
      throw new ValidationFailedError('Only a POSTED payment can be applied', {
        id,
        status: payment.status,
      });
    if (date.getTime() < payment.date.getTime())
      throw new ValidationFailedError(
        'Application date cannot be before the payment date',
        {
          id,
          date: date.toISOString().slice(0, 10),
          paymentDate: payment.date.toISOString().slice(0, 10),
        },
      );
    const target = PAYMENT_TARGETS[payment.direction];
    const total = await this.checkAllocations(
      target,
      payment.partnerId,
      date,
      allocations,
    );
    assertWithinUnapplied(id, payment.unappliedAmount.toString(), total);
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
            description: `Application of payment ${payment.ref ?? id}`,
            sourceType: 'PAYMENT',
            sourceId: id,
            createdBy: payment.createdBy,
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
      const [locked] = await tx.$queryRaw<
        { status: string; unapplied_amount: string }[]
      >`
        SELECT status, unapplied_amount::text AS unapplied_amount FROM payments
        WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
      if (!locked || locked.status !== 'POSTED')
        throw new ValidationFailedError('Payment is no longer posted', { id });
      assertWithinUnapplied(id, locked.unapplied_amount, total);
      await this.assertPartnerInTx(tx, payment.partnerId, target);
      const settled = new Map<string, Money>();
      for (const a of inLockOrder(target, allocations)) {
        const docId = target.allocId(a)!;
        const before = settled.get(docId) ?? Money.zero();
        await settleInTx(tx, target, a, payment.partnerId, date, before);
        settled.set(docId, before.add(Money.of(a.amount)));
      }
      for (const [i, a] of allocations.entries()) {
        const entry = await this.posting.createPostedEntryInTx(tx, prepared[i]);
        await tx.paymentApplication.create({
          data: {
            paymentId: id,
            salesInvoiceId: a.salesInvoiceId,
            purchaseBillId: a.purchaseBillId,
            amount: Money.of(a.amount).toPersistence(),
            date,
            journalEntryId: entry.id,
            createdBy: appliedBy,
          },
        });
      }
      await tx.payment.update({
        where: { id },
        data: { unappliedAmount: { decrement: total.toPersistence() } },
      });
    }, POSTING_TX_OPTIONS);
    return this.getById(id);
  }

  /** Undo one application: reverse its journal entry (dated `date`, default
   *  the application date; never after today (WIB) or before the application
   *  date), give the amount back to the document's outstanding and to the
   *  payment's unapplied balance. Same locks and partner rule as a payment
   *  void (payment FOR UPDATE → partner FOR SHARE → document FOR UPDATE). */
  async reverseApplication(
    id: string,
    applicationId: string,
    reversedBy: string,
    date?: Date,
  ): Promise<PaymentWithAllocations> {
    const application = await this.prisma.client.paymentApplication.findFirst({
      where: { id: applicationId, paymentId: id },
    });
    if (!application)
      throw new NotFoundDomainError('Payment application not found', {
        id,
        applicationId,
      });
    if (application.reversedOn)
      throw new ValidationFailedError(
        'Payment application was already reversed',
        { id, applicationId },
      );
    if (date)
      assertNotAfterToday(date, 'Reversal date cannot be in the future', {
        originalDate: application.date,
      });
    const reversedOn = date ?? application.date;
    const payment = await this.getById(id);
    const target = PAYMENT_TARGETS[payment.direction];
    await this.lifecycle.reverseWithGuard({
      id,
      journalEntryId: application.journalEntryId,
      reversedBy,
      reversalDate: reversedOn,
      alreadyReversedMessage: 'Payment application was already reversed',
      notPostedMessage: 'Payment is not posted',
      lock: async (tx) => {
        const locked = await tx.$queryRaw<{ status: string }[]>`
          SELECT status FROM payments WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
        return locked[0];
      },
      applyInTx: async (tx) => {
        const [row] = await tx.$queryRaw<{ reversed_on: Date | null }[]>`
          SELECT reversed_on FROM payment_applications WHERE id = ${applicationId}`;
        if (row.reversed_on)
          throw new ValidationFailedError(
            'Payment application was already reversed',
            { id, applicationId },
          );
        if (!(await lockLivePartnerForShare(tx, payment.partnerId)))
          throw new ValidationFailedError(
            'Cannot reverse an application whose partner has been deleted',
            { id, partnerId: payment.partnerId, reason: 'PARTNER_DELETED' },
          );
        await unwindInTx(tx, target, toAllocationInput(application));
        await tx.paymentApplication.update({
          where: { id: applicationId },
          data: { reversedOn, reversedBy },
        });
        await tx.payment.update({
          where: { id },
          data: { unappliedAmount: { increment: application.amount } },
        });
      },
    });
    return this.getById(id);
  }
}

/** 422 when `requested` exceeds the payment's unapplied balance. */
function assertWithinUnapplied(
  id: string,
  unappliedAmount: string,
  requested: Money,
): void {
  if (Money.of(unappliedAmount).subtract(requested).isNegative())
    throw new ValidationFailedError(
      'Application exceeds the payment unapplied amount',
      {
        id,
        unappliedAmount: Money.of(unappliedAmount).toPersistence(),
        requested: requested.toPersistence(),
      },
    );
}

/** Payment-void precondition, read under the payment FOR UPDATE lock: no live
 *  application (422 HAS_APPLICATIONS — reverse them first), and the void date
 *  on/after every reversed application's reversal date (else the advance
 *  account would, for the days between, carry the reversed application's
 *  debit against a payment already voided). */
async function assertNoLiveApplicationsInTx(
  tx: LedgerTx,
  id: string,
  voidedOn: Date,
): Promise<void> {
  const [r] = await tx.$queryRaw<
    { live: number; last_reversed_on: Date | null }[]
  >`
    SELECT count(*) FILTER (WHERE reversed_on IS NULL)::int AS live,
           max(reversed_on) AS last_reversed_on
    FROM payment_applications WHERE payment_id = ${id}`;
  if (r.live > 0)
    throw new ValidationFailedError(
      "Reverse this payment's applications before voiding it",
      { id, reason: 'HAS_APPLICATIONS', applications: r.live },
    );
  if (r.last_reversed_on && r.last_reversed_on.getTime() > voidedOn.getTime())
    throw new ValidationFailedError(
      'Void date cannot be before the reversal date of an application of this payment',
      {
        id,
        date: voidedOn.toISOString().slice(0, 10),
        applicationReversedOn: r.last_reversed_on.toISOString().slice(0, 10),
      },
    );
}
