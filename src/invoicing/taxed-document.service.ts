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
import { LedgerTx } from '../ledger/posting/posting.service';
import { trigramSearch } from '../common/search/trigram-search';
import { listPaginated } from '../common/pagination/paginated';
import { taxableLines, findControlAccountId } from './document-helpers';
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
    const partner = await this.partners.findById(input.partnerId);
    if (!partner[spec.partnerFlag] || !partner.isActive)
      throw new ValidationFailedError(m.partnerInactive, {
        partnerId: input.partnerId,
      });
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
    return spec.createRow(common, input);
  }

  async update<
    R extends DocumentRow,
    C extends CreateDocumentInput,
    U extends UpdateDocumentInput,
  >(spec: Spec<R, C, U>, id: string, input: U): Promise<R> {
    const m = documentMessages(spec);
    const row = await this.getById(spec, id);
    if (row.status !== 'DRAFT')
      throw new ValidationFailedError(m.onlyDraftEdit, {
        id,
        status: row.status,
      });
    const nextLines =
      input.lines ??
      (row.lines ?? []).map((l) => ({
        description: l.description,
        accountId: l.accountId,
        quantity: l.quantity.toString(),
        unitPrice: l.unitPrice.toString(),
        taxCodeIds: l.taxCodeIds,
      }));
    const settlementId = await findControlAccountId(
      this.prisma,
      spec.controlRole,
    );
    const totals = await this.docPosting.computeTotals(
      spec.nature,
      settlementId,
      taxableLines(nextLines),
    );
    const common = {
      date: input.date ?? row.date,
      dueDate: input.dueDate ?? row.dueDate,
      description: input.description ?? row.description,
      subtotal: totals.subtotal,
      taxTotal: totals.taxTotal,
      withholdingTotal: totals.withholdingTotal,
      total: totals.total,
      lines: { create: buildLineCreateData(nextLines) },
    };
    await this.prisma.client.$transaction(async (tx) => {
      const ltx = tx as unknown as LedgerTx;
      await spec.updateRow(ltx, id, common, input, row);
    });
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
          ownColumns: spec.trigramColumns as [string, ...string[]],
          join: {
            table: 'business_partners',
            alias: 'p',
            onColumn: 'partner_id',
            columns: ['name'],
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
      },
      (tx) => this.lockDraft(tx, spec, id),
      (ctx) => spec.finalizePosted(ctx.tx, id, ctx, postedBy),
    );
    return this.getById(spec, id);
  }

  async void<
    R extends DocumentRow,
    C extends CreateDocumentInput,
    U extends UpdateDocumentInput,
  >(spec: Spec<R, C, U>, id: string, voidedBy: string): Promise<R> {
    const m = documentMessages(spec);
    const row = await this.getById(spec, id);
    if (row.status !== 'POSTED')
      throw new ValidationFailedError(m.onlyPostedVoid, {
        id,
        status: row.status,
      });
    if (!Money.of(row.amountPaid.toString()).isZero())
      throw new ConflictDomainError(m.voidWithPaymentsFirst, { id });
    await this.lifecycle.reverseWithGuard({
      id,
      journalEntryId: row.journalEntryId!,
      reversedBy: voidedBy,
      alreadyReversedMessage: m.alreadyReversed,
      notPostedMessage: m.notPosted,
      lock: (tx) => this.lockForVoid(tx, spec, id),
      applyInTx: async (tx, locked) => {
        if (Number(locked.amount_paid) !== 0)
          throw new ConflictDomainError(m.voidWithPayments, { id });
        await spec.markVoid(tx, id);
      },
    });
    return this.getById(spec, id);
  }

  /** FOR UPDATE draft lock built from the descriptor's constant table identifier. */
  private async lockDraft<
    R extends DocumentRow,
    C extends CreateDocumentInput,
    U extends UpdateDocumentInput,
  >(tx: LedgerTx, spec: Spec<R, C, U>, id: string): Promise<void> {
    const rows = await tx.$queryRaw<{ status: string }[]>(
      Prisma.sql`SELECT status FROM ${Prisma.raw(spec.table)} WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`,
    );
    if (rows.length === 0 || rows[0].status !== 'DRAFT')
      throw new ValidationFailedError(documentMessages(spec).noLongerDraft, {
        id,
      });
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
}
