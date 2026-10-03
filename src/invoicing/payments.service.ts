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
import { lockLiveRow } from '../common/db/lock-live-row';
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
  resolveVoidDate,
  findControlAccountId,
  nextDocumentNumber,
} from './document-helpers';
import { DocumentLifecycleService } from '../ledger/document-lifecycle.service';
import {
  assertCashAccount,
  assertOpeningEquityAccount,
  assertPaymentCashAccountPostable,
} from './document-account-rules';
import { lockLivePartnerForShare } from './partner-lock';
import { presentApplications } from './document-presenter';
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
  /** Required unless `opening` (which books against Saldo Awal instead). */
  cashAccountId?: string;
  /** A go-live customer deposit / vendor prepayment: no cash moves, the
   *  journal is Dr Saldo Awal / Cr Uang Muka Pelanggan (receipt) or
   *  Dr Uang Muka Pembelian / Cr Saldo Awal (disbursement), and the whole
   *  `amount` is unapplied credit to apply or refund later. */
  opening?: boolean;
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
    const cashAccountId = await this.counterAccountFor(input);

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
          cashAccountId,
          opening: input.opening ?? false,
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

  /** The payment's cash-side account. A normal payment: the caller's
   *  account, with the same checks, order and errors as preview / post —
   *  exists, live, postable, active (422 INVALID_ACCOUNT { accountId }, the
   *  posting path's own check under the PAYMENT policy), then the CASH role
   *  (422 VALIDATION_FAILED). An opening credit: no cash account and no
   *  allocations allowed, `amount` required; the Saldo Awal
   *  (OPENING_BALANCE_EQUITY) account takes the cash slot, so the opening
   *  entry's cash is never counted twice. */
  private async counterAccountFor(input: CreatePaymentInput): Promise<string> {
    if (!input.opening) {
      if (!input.cashAccountId)
        throw new ValidationFailedError('cashAccountId is required', {});
      await assertPaymentCashAccountPostable(
        this.posting,
        this.prisma.client,
        input.cashAccountId,
      );
      return input.cashAccountId;
    }
    if (input.cashAccountId || input.allocations.length > 0)
      throw new ValidationFailedError(
        'An opening credit takes no cash account and no allocations (it books against Saldo Awal; apply or refund it after posting)',
        { reason: 'OPENING_CREDIT_SHAPE' },
      );
    if (input.amount === undefined)
      throw new ValidationFailedError('An opening credit needs an amount', {
        reason: 'OPENING_CREDIT_SHAPE',
      });
    return findControlAccountId(this.prisma, 'OPENING_BALANCE_EQUITY');
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
        .subtract(Money.of(targetRow.creditedTotal.toString()))
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
      model: this.prisma.client.payment,
      where,
      orderBy: { createdAt: 'desc' },
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
      const lockedP = await lockLiveRow<{ status: string }>(
        tx,
        'payments',
        id,
        'status',
      );
      if (!lockedP || lockedP.status !== 'DRAFT')
        throw new ValidationFailedError('Payment is no longer a draft', {
          id,
        });
      // A draft payment has no edit path (create / delete / post only), so
      // the cashAccountId, amount and allocations read before this tx are
      // the locked row's; a concurrent delete fails the re-check above.
      // Post-time re-validation: the cash side must still be a CASH-role
      // account (catches drafts written before the rule existed) — or, for
      // an opening credit, the Saldo Awal account.
      if (payment.opening)
        await assertOpeningEquityAccount(tx, payment.cashAccountId);
      else await assertCashAccount(tx, payment.cashAccountId);
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
    const voidedOn = resolveVoidDate(
      payment,
      date,
      'Only a POSTED payment can be voided',
    );
    const allocations = payment.allocations.map(toAllocationInput);
    await this.lifecycle.reverseWithGuard({
      id,
      journalEntryId: payment.journalEntryId!,
      reversedBy: voidedBy,
      reversalDate: voidedOn,
      alreadyReversedMessage: 'Payment journal entry was already reversed',
      notPostedMessage: 'Payment is not posted',
      lock: (tx) =>
        lockLiveRow<{ status: string }>(tx, 'payments', id, 'status'),
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
        await assertNoLiveApplicationsInTx(
          tx,
          { noun: 'payment', holderField: 'paymentId' },
          id,
          voidedOn,
        );
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
      ...(applications ? presentApplications(applications) : {}),
    };
  }

  /** Move part of a POSTED payment's unapplied (advance) amount onto
   *  invoices (receipt) / bills (disbursement) of the same partner, dated
   *  `date` (on/after the payment and each document). See applyCredit. */
  async apply(
    id: string,
    date: Date,
    allocations: AllocationInput[],
    appliedBy: string,
  ): Promise<PaymentWithAllocations> {
    const payment = await this.getById(id);
    await this.applyCredit(
      paymentCreditSource(payment.direction),
      creditHolderOf(payment),
      date,
      allocations,
      appliedBy,
    );
    return this.getById(id);
  }

  /** Undo one application of a payment's advance. See reverseCreditApplication. */
  async reverseApplication(
    id: string,
    applicationId: string,
    reversedBy: string,
    date?: Date,
  ): Promise<PaymentWithAllocations> {
    const payment = await this.getById(id);
    await this.reverseCreditApplication(
      paymentCreditSource(payment.direction),
      creditHolderOf(payment),
      applicationId,
      reversedBy,
      date,
    );
    return this.getById(id);
  }

  /** Refund part of a POSTED payment's unapplied (advance) amount in cash.
   *  See refundCredit. */
  async refund(
    id: string,
    refund: CreditRefundInput,
    refundedBy: string,
  ): Promise<PaymentWithAllocations> {
    const payment = await this.getById(id);
    await this.refundCredit(
      paymentCreditSource(payment.direction),
      creditHolderOf(payment),
      refund,
      refundedBy,
    );
    return this.getById(id);
  }

  /** Undo one refund of a payment's advance (its journal is reversed; the
   *  amount returns to the unapplied balance). */
  async reverseRefund(
    id: string,
    refundId: string,
    reversedBy: string,
    date?: Date,
  ): Promise<PaymentWithAllocations> {
    const payment = await this.getById(id);
    await this.reverseCreditApplication(
      paymentCreditSource(payment.direction),
      creditHolderOf(payment),
      refundId,
      reversedBy,
      date,
      'refund',
    );
    return this.getById(id);
  }

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
    const total = await this.checkAllocations(
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
      await this.assertPartnerInTx(tx, holder.partnerId, target);
      const settled = new Map<string, Money>();
      for (const a of inLockOrder(target, allocations)) {
        const docId = target.allocId(a)!;
        const before = settled.get(docId) ?? Money.zero();
        await settleInTx(tx, target, a, holder.partnerId, date, before);
        settled.set(docId, before.add(Money.of(a.amount)));
      }
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
      await this.assertPartnerInTx(tx, holder.partnerId, source.target);
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

function paymentCreditSource(direction: PaymentDirection): CreditSource {
  return {
    noun: 'payment',
    table: 'payments',
    holderField: 'paymentId',
    dateKey: 'paymentDate',
    sourceType: 'PAYMENT',
    target: PAYMENT_TARGETS[direction],
  };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
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
