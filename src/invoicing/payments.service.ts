import { Injectable } from '@nestjs/common';
import {
  DocumentStatus,
  Payment,
  PaymentDirection,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { trigramSearch } from '../common/search/trigram-search';
import { Money } from '../common/money/money';
import { lockLiveRow } from '../common/db/lock-live-row';
import {
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
  settleAllInTx,
  unwindInTx,
  buildPaymentLines,
  inLockOrder,
  checkAllocations,
  assertPartnerInTx,
  toAllocationInput,
} from './payment-targets';
import {
  CreditApplicationService,
  CreditRefundInput,
  CreditSource,
  assertNoLiveApplicationsInTx,
  creditHolderOf,
} from './credit-application';

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

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly partners: BusinessPartnersService,
    private readonly posting: PostingService,
    private readonly lifecycle: DocumentLifecycleService,
    private readonly credit: CreditApplicationService,
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

    const allocated = await checkAllocations(
      this.prisma.client,
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
      await assertPartnerInTx(tx, input.partnerId, target);
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
      await assertPartnerInTx(tx, payment.partnerId, target);

      // Lock each target document FOR UPDATE and re-verify outstanding (the
      // real over-allocation guard) and payment date >= document date — in
      // id order, so concurrent payments over overlapping documents can't
      // deadlock (settleAllInTx).
      await settleAllInTx(
        tx,
        target,
        allocations,
        payment.partnerId,
        payment.date,
      );

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
    await this.credit.applyCredit(
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
    await this.credit.reverseCreditApplication(
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
    await this.credit.refundCredit(
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
    await this.credit.reverseCreditApplication(
      paymentCreditSource(payment.direction),
      creditHolderOf(payment),
      refundId,
      reversedBy,
      date,
      'refund',
    );
    return this.getById(id);
  }
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
