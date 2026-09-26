import { Injectable } from '@nestjs/common';
import { DocumentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import {
  ConflictDomainError,
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';
import { BusinessPartnersService } from './business-partners.service';
import { DocumentPostingService } from './document-posting.service';
import { DocumentLifecycleService } from '../ledger/document-lifecycle.service';
import {
  LedgerTx,
  POSTING_TX_OPTIONS,
} from '../ledger/posting/posting.service';
import { trigramSearch } from '../common/search/trigram-search';
import { listPaginated } from '../common/pagination/paginated';
import {
  taxableLines,
  findControlAccountId,
  assertVoidDateNotBefore,
  assertDueDateNotBefore,
  samePostableContent,
} from './document-helpers';
import {
  DocumentDescriptor,
  DocumentRow,
  CreateDocumentInput,
  UpdateDocumentInput,
  DocumentListWhere,
} from './document-descriptor';
import {
  presentDocument,
  buildLineCreateData,
  documentMessages,
} from './document-presenter';
import { assertDocumentLineAccounts } from './document-account-rules';

/** Posting restarts from a fresh read at most this many times when the draft
 *  is edited between its pre-read and the row lock, then answers 409. */
const MAX_POST_ATTEMPTS = 3;

/** Internal signal: the locked draft no longer matches the pre-lock read. */
class DraftChangedError extends Error {}

type Spec<
  R extends DocumentRow,
  C extends CreateDocumentInput,
  U extends UpdateDocumentInput,
> = DocumentDescriptor<R, C, U>;

interface ListQuery {
  q?: string;
  partnerId?: string;
  status?: DocumentStatus;
  limit?: number;
  offset?: number;
}

/**
 * The single writer/reader of a "taxed trade document" (sales invoice /
 * purchase bill): documents that run through the tax engine and post to an
 * AR/AP control account. Stateless — every method takes a typed
 * DocumentDescriptor. Owns validation ordering, messages, line Money-math,
 * the draft lock, and orchestration; the descriptor supplies the typed
 * per-model Prisma calls.
 */
@Injectable()
export class TaxedDocumentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly partners: BusinessPartnersService,
    private readonly docPosting: DocumentPostingService,
    private readonly lifecycle: DocumentLifecycleService,
  ) {}

  async getById<
    R extends DocumentRow,
    C extends CreateDocumentInput,
    U extends UpdateDocumentInput,
  >(spec: Spec<R, C, U>, id: string): Promise<R> {
    const row = await spec.findById(id);
    if (!row)
      throw new NotFoundDomainError(documentMessages(spec).notFound, { id });
    return row;
  }

  async createDraft<
    R extends DocumentRow,
    C extends CreateDocumentInput,
    U extends UpdateDocumentInput,
  >(spec: Spec<R, C, U>, input: C): Promise<R> {
    const m = documentMessages(spec);
    assertDueDateNotBefore(input.date, input.dueDate);
    const partner = await this.partners.findById(input.partnerId);
    if (!partner[spec.partnerFlag] || !partner.isActive)
      throw new ValidationFailedError(m.partnerInactive, {
        partnerId: input.partnerId,
      });
    await assertDocumentLineAccounts(
      this.prisma.client,
      spec.nature,
      input.lines.map((l) => l.accountId),
    );
    const settlementId = await findControlAccountId(
      this.prisma,
      spec.controlRole,
    );
    const totals = await this.docPosting.computeTotals(
      spec.nature,
      settlementId,
      taxableLines(input.lines),
    );
    const common = {
      partnerId: input.partnerId,
      date: input.date,
      dueDate: input.dueDate,
      description: input.description,
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      withholdingTotal: totals.withholdingTotal,
      total: totals.total,
      createdBy: input.createdBy,
      lines: { create: buildLineCreateData(input.lines) },
    };
    // A single insert, but still a transaction: under an Idempotency-Key the
    // key is marked committed atomically with it (see PrismaService.transaction).
    return this.prisma.transaction((tx) => spec.createRow(tx, common, input));
  }

  /** Edit a DRAFT. The whole edit runs in one transaction that first locks the
   *  document row FOR UPDATE and re-checks it is still a live DRAFT — the same
   *  row lock posting takes first — so an edit and a post fully serialize: a
   *  post that wins leaves the edit a 422 onlyDraftEdit, and an edit that wins
   *  is what the post then sees. Lines/totals are derived from the row read
   *  under that lock (tax-code/account reads go through the same tx). */
  async update<
    R extends DocumentRow,
    C extends CreateDocumentInput,
    U extends UpdateDocumentInput,
  >(spec: Spec<R, C, U>, id: string, input: U): Promise<R> {
    const m = documentMessages(spec);
    await this.getById(spec, id); // 404 for an unknown / deleted id
    const settlementId = await findControlAccountId(
      this.prisma,
      spec.controlRole,
    );
    await this.prisma.transaction(
      async (tx) => {
        const ltx: LedgerTx = tx;
        await this.lockDraftRow(ltx, spec, id, m.onlyDraftEdit);
        // Present: the row is locked live above, so this read cannot miss it.
        const row = (await spec.findById(id, ltx))!;
        const nextLines =
          input.lines ??
          (row.lines ?? []).map((l) => ({
            description: l.description,
            accountId: l.accountId,
            quantity: l.quantity.toString(),
            unitPrice: l.unitPrice.toString(),
            taxCodeIds: l.taxCodeIds,
          }));
        await assertDocumentLineAccounts(
          ltx,
          spec.nature,
          nextLines.map((l) => l.accountId),
        );
        const totals = await this.docPosting.computeTotals(
          spec.nature,
          settlementId,
          taxableLines(nextLines),
          ltx,
        );
        const common = {
          date: input.date ?? row.date,
          // Explicit null clears; omitted (undefined) keeps the stored value.
          dueDate: input.dueDate === undefined ? row.dueDate : input.dueDate,
          description:
            input.description === undefined
              ? row.description
              : input.description,
          subtotal: totals.subtotal,
          taxTotal: totals.taxTotal,
          withholdingTotal: totals.withholdingTotal,
          total: totals.total,
          lines: { create: buildLineCreateData(nextLines) },
        };
        // Judged on the merged (effective) values: moving only the date past
        // the stored due date is rejected too.
        assertDueDateNotBefore(common.date, common.dueDate);
        await spec.updateRow(ltx, id, common, input, row);
      },
      // An edit racing a post waits out the post's row lock here; give it room
      // to reach its clean 422 instead of Prisma's 5s default (→ 500 under load).
      POSTING_TX_OPTIONS,
    );
    return this.getById(spec, id);
  }

  listPage<
    R extends DocumentRow,
    C extends CreateDocumentInput,
    U extends UpdateDocumentInput,
  >(spec: Spec<R, C, U>, q: ListQuery) {
    const filters: Prisma.Sql[] = [];
    if (q.partnerId) filters.push(Prisma.sql`t.partner_id = ${q.partnerId}`);
    if (q.status) filters.push(Prisma.sql`t.status::text = ${q.status}`);
    const where: DocumentListWhere = {
      partnerId: q.partnerId,
      status: q.status,
    };
    return listPaginated({
      q: q.q,
      limit: q.limit,
      offset: q.offset,
      present: (r: R) => presentDocument(r),
      search: ({ term, limit, offset }) =>
        trigramSearch(this.prisma, {
          table: spec.table,
          alias: 't',
          ownColumns: spec.trigramColumns,
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
      hydrate: (ids) => spec.hydrate(ids),
      page: ({ limit, offset }) => spec.page({ where, limit, offset }),
    });
  }

  deleteDraft<
    R extends DocumentRow,
    C extends CreateDocumentInput,
    U extends UpdateDocumentInput,
  >(spec: Spec<R, C, U>, id: string, deletedBy: string): Promise<void> {
    return this.lifecycle.softDeleteDraft(spec.model, id, deletedBy, spec.noun);
  }

  async post<
    R extends DocumentRow,
    C extends CreateDocumentInput,
    U extends UpdateDocumentInput,
  >(spec: Spec<R, C, U>, id: string, postedBy: string): Promise<R> {
    const m = documentMessages(spec);
    // The entry is prepared (tax, period, SoD, accounts) from a pre-lock read to
    // keep those reads out of the write tx; under the row lock the stored draft
    // is re-read and must still match it. A draft edited in between restarts the
    // post from the fresh read (bounded), so what is posted is always the row
    // as it stands under the lock.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.postOnce(spec, id, postedBy, m);
        return this.getById(spec, id);
      } catch (err) {
        if (!(err instanceof DraftChangedError)) throw err;
        if (attempt >= MAX_POST_ATTEMPTS)
          throw new ConflictDomainError(m.changedDuringPost, { id });
      }
    }
  }

  private async postOnce<
    R extends DocumentRow,
    C extends CreateDocumentInput,
    U extends UpdateDocumentInput,
  >(
    spec: Spec<R, C, U>,
    id: string,
    postedBy: string,
    m: ReturnType<typeof documentMessages>,
  ): Promise<void> {
    const row = await this.getById(spec, id);
    if (row.status !== 'DRAFT')
      throw new ValidationFailedError(m.notADraft, { id, status: row.status });
    const partner = await this.partners.findById(row.partnerId);
    if (!partner[spec.partnerFlag] || !partner.isActive)
      throw new ValidationFailedError(m.partnerInactive, {
        partnerId: row.partnerId,
      });
    const settlementId = await findControlAccountId(
      this.prisma,
      spec.controlRole,
    );

    await this.docPosting.post(
      {
        nature: spec.nature,
        settlementAccountId: settlementId,
        date: row.date,
        description: row.description ?? m.defaultDescription(id),
        sourceType: spec.sourceType,
        sourceId: id,
        createdBy: row.createdBy,
        postedBy,
        documentType: spec.documentType,
        lines: taxableLines(row.lines ?? []),
        table: spec.table,
        notDraftMessage: m.noLongerDraft,
        verifyLockedInTx: async (tx) => {
          const locked = await spec.findById(id, tx);
          if (!locked || !samePostableContent(row, locked))
            throw new DraftChangedError();
        },
      },
      (ctx) => spec.finalizePosted(ctx.tx, id, ctx, postedBy),
    );
  }

  async void<
    R extends DocumentRow,
    C extends CreateDocumentInput,
    U extends UpdateDocumentInput,
  >(
    spec: Spec<R, C, U>,
    id: string,
    voidedBy: string,
    date?: Date,
  ): Promise<R> {
    const m = documentMessages(spec);
    const row = await this.getById(spec, id);
    if (row.status !== 'POSTED')
      throw new ValidationFailedError(m.onlyPostedVoid, {
        id,
        status: row.status,
      });
    // The void (reversal) date defaults to the document date; a later date lets
    // a document be voided after its own period has closed.
    const voidedOn = date ?? row.date;
    assertVoidDateNotBefore(voidedOn, row.date, id);
    if (!Money.of(row.amountPaid.toString()).isZero())
      throw new ConflictDomainError(m.voidWithPaymentsFirst, { id });
    await this.lifecycle.reverseWithGuard({
      id,
      journalEntryId: row.journalEntryId!,
      reversedBy: voidedBy,
      reversalDate: voidedOn,
      alreadyReversedMessage: m.alreadyReversed,
      notPostedMessage: m.notPosted,
      lock: (tx) => this.lockForVoid(tx, spec, id),
      applyInTx: async (tx, locked) => {
        if (!Money.of(locked.amount_paid.toString()).isZero())
          throw new ConflictDomainError(m.voidWithPayments, { id });
        await this.assertNoLaterVoidedPayment(tx, spec, id, voidedOn);
        await spec.markVoid(tx, id, voidedOn);
      },
    });
    return this.getById(spec, id);
  }

  /** A payment allocated to this document that was voided on a LATER date than
   *  its own date still credits the control account until its void date. If the
   *  document were voided before that, AR/AP control would carry the payment
   *  with no live document to age it against (aging ≠ control for the dates in
   *  between). Require the document void date to be on/after such a payment's
   *  void date. Runs under the document FOR UPDATE lock, which the payment void
   *  (unwindInTx) also takes, so the read sees every committed payment void. */
  private async assertNoLaterVoidedPayment<
    R extends DocumentRow,
    C extends CreateDocumentInput,
    U extends UpdateDocumentInput,
  >(
    tx: LedgerTx,
    spec: Spec<R, C, U>,
    id: string,
    voidedOn: Date,
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ ref: string | null; voided_on: Date }[]>(
      Prisma.sql`
        SELECT p.ref, p.voided_on FROM payment_allocations pa
        JOIN payments p ON p.id = pa.payment_id
        WHERE pa.${Prisma.raw(spec.allocationColumn)} = ${id}
          AND p.status = 'VOID' AND p.deleted_at IS NULL
          AND p.voided_on > p.date AND p.voided_on > ${voidedOn}
        ORDER BY p.voided_on DESC
        LIMIT 1`,
    );
    if (rows.length > 0)
      throw new ValidationFailedError(
        'Void date cannot be before the void date of a payment allocated to this document',
        {
          id,
          date: voidedOn.toISOString().slice(0, 10),
          paymentRef: rows[0].ref,
          paymentVoidedOn: rows[0].voided_on.toISOString().slice(0, 10),
        },
      );
  }

  /** FOR UPDATE lock for void: returns status + amount_paid for the in-tx re-check. */
  private async lockForVoid<
    R extends DocumentRow,
    C extends CreateDocumentInput,
    U extends UpdateDocumentInput,
  >(
    tx: LedgerTx,
    spec: Spec<R, C, U>,
    id: string,
  ): Promise<{ status: string; amount_paid: string } | undefined> {
    const rows = await tx.$queryRaw<{ status: string; amount_paid: string }[]>(
      Prisma.sql`SELECT status, amount_paid FROM ${Prisma.raw(spec.table)} WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`,
    );
    return rows[0];
  }

  /** FOR UPDATE the document row and re-check it is still a live DRAFT; the
   *  first statement of every draft mutation (same first lock as posting).
   *  404 if the row is gone, 422 `message` if it is no longer a DRAFT. */
  private async lockDraftRow<
    R extends DocumentRow,
    C extends CreateDocumentInput,
    U extends UpdateDocumentInput,
  >(
    tx: LedgerTx,
    spec: Spec<R, C, U>,
    id: string,
    message: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ status: string }[]>(
      Prisma.sql`SELECT status FROM ${Prisma.raw(spec.table)} WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`,
    );
    // Row gone (deleted since the pre-read) → the same 404 getById gives.
    if (rows.length === 0)
      throw new NotFoundDomainError(documentMessages(spec).notFound, { id });
    if (rows[0].status !== 'DRAFT')
      throw new ValidationFailedError(message, { id, status: rows[0].status });
  }
}
