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
  LedgerTx,
  POSTING_TX_OPTIONS,
  PostingService,
} from '../ledger/posting/posting.service';
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
  loadTarget,
  settleInTx,
  unwindInTx,
  buildPaymentLines,
  inLockOrder,
  assertPaymentDateNotBefore,
  assertNoBackdatedOverAllocation,
} from './payment-targets';

/** A payment row with its allocations eagerly loaded — what getById always returns. */
type PaymentWithAllocations = Prisma.PaymentGetPayload<{
  include: { allocations: true };
}>;

export interface CreatePaymentInput {
  direction: PaymentDirection;
  partnerId: string;
  date: Date;
  cashAccountId: string;
  description?: string;
  allocations: AllocationInput[];
  createdBy: string;
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly partners: BusinessPartnersService,
    private readonly posting: PostingService,
    private readonly lifecycle: DocumentLifecycleService,
  ) {}

  async createDraft(input: CreatePaymentInput): Promise<Payment> {
    if (input.allocations.length === 0)
      throw new ValidationFailedError(
        'A payment needs at least one allocation',
        {},
      );
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

    let total = Money.zero();
    const allocatedByDoc = new Map<string, Money>();
    for (const alloc of input.allocations) {
      const amt = Money.of(alloc.amount);
      if (amt.isZero() || amt.isNegative())
        throw new ValidationFailedError(
          'Allocation amount must be positive',
          {},
        );
      const targetRow = await loadTarget(this.prisma.client, target, alloc);
      if (targetRow.partnerId !== input.partnerId)
        throw new ValidationFailedError(
          'Allocated document belongs to another partner',
          { documentId: targetRow.id },
        );
      if (targetRow.status !== 'POSTED')
        throw new ValidationFailedError(
          'Can only allocate to a POSTED document',
          { documentId: targetRow.id, status: targetRow.status },
        );
      assertPaymentDateNotBefore(input.date, targetRow);
      // Outstanding net of what THIS payment already allocated to the same
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
        input.date,
        alreadyAllocated.add(amt).toPersistence(),
      );
      allocatedByDoc.set(targetRow.id, alreadyAllocated.add(amt));
      total = total.add(amt);
    }

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
        include: { allocations: true },
      });
    });
  }

  async getById(id: string): Promise<PaymentWithAllocations> {
    const p = await this.prisma.client.payment.findFirst({
      where: { id },
      include: { allocations: true },
    });
    if (!p) throw new NotFoundDomainError('Payment not found', { id });
    return p;
  }

  async listPage(q: {
    q?: string;
    partnerId?: string;
    direction?: PaymentDirection;
    status?: DocumentStatus;
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
    const where = {
      partnerId: q.partnerId,
      direction: q.direction,
      status: q.status,
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
    const allocations = payment.allocations.map(
      (a): AllocationInput => ({
        salesInvoiceId: a.salesInvoiceId ?? undefined,
        purchaseBillId: a.purchaseBillId ?? undefined,
        amount: a.amount.toString(),
      }),
    );
    const target = PAYMENT_TARGETS[payment.direction];
    const controlId = await findControlAccountId(
      this.prisma,
      target.controlRole,
    );
    const amount = Money.of(payment.amount.toString());

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
    const allocations = payment.allocations.map(
      (a): AllocationInput => ({
        salesInvoiceId: a.salesInvoiceId ?? undefined,
        purchaseBillId: a.purchaseBillId ?? undefined,
        amount: a.amount.toString(),
      }),
    );
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
        const target = PAYMENT_TARGETS[payment.direction];
        for (const a of inLockOrder(target, allocations)) {
          await unwindInTx(tx, target, a);
        }
        await tx.payment.update({
          where: { id },
          data: { status: 'VOID', voidedOn },
        });
      },
    });
    return this.getById(id);
  }

  /** Shape the API response. Money columns are normalized to 4dp strings (matching
   *  the ledger/invoice serialization convention) since Prisma's Decimal#toJSON
   *  strips trailing zeros. */
  present(
    payment: Payment & { allocations?: PaymentWithAllocations['allocations'] },
  ): Payment {
    const allocations = payment.allocations;
    return {
      ...serializeMoney(payment, ['amount']),
      ...(allocations
        ? {
            allocations: allocations.map((a) => serializeMoney(a, ['amount'])),
          }
        : {}),
    };
  }
}
