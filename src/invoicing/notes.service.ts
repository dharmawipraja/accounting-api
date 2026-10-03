import { Injectable } from '@nestjs/common';
import {
  DocumentStatus,
  PaymentApplication,
  Prisma,
  SalesCreditNote,
  SalesCreditNoteLine,
} from '@prisma/client';
import { assertNotAfterToday } from '../common/dates/not-after-today';
import { PrismaService } from '../common/prisma/prisma.service';
import type { LedgerTx } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import { serializeMoney } from '../common/money/serialize-money';
import {
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';
import { DocumentLifecycleService } from '../ledger/document-lifecycle.service';
import { TaxedDocumentService } from './taxed-document.service';
import { DraftChangedError } from './document-posting.service';
import {
  CreateDocumentInput,
  DocumentDescriptor,
  DocumentLineCreateData,
  DocumentPostHooks,
  UpdateDocumentInput,
} from './document-descriptor';
import { documentMessages } from './document-presenter';
import {
  assertVoidDateNotBefore,
  findControlAccountId,
} from './document-helpers';
import {
  AllocationInput,
  PAYMENT_TARGETS,
  PaymentTarget,
  assertNoBackdatedOverAllocation,
} from './payment-targets';
import {
  CreditSource,
  PaymentsService,
  assertNoLiveApplicationsInTx,
  creditHolderOf,
} from './payments.service';
import { lockLivePartnerForShare } from './partner-lock';
import {
  NoteLineInput,
  OriginalLine,
  noteJournalLines,
  returnedLine,
  splitSettlement,
} from './note-lines';

export type NoteKindKey = 'SALES' | 'PURCHASE';

/** A credit/debit note row (both tables have the same columns). */
export type NoteRow = SalesCreditNote & {
  lines?: SalesCreditNoteLine[];
  applications?: PaymentApplication[];
};

/** What a caller asks to return: original lines and quantities. */
export interface NoteLineRequest {
  originalLineId: string;
  quantity: string;
}

export interface CreateNoteRequest {
  originalId: string;
  date: Date;
  description?: string;
  lines: NoteLineRequest[];
  createdBy: string;
}

export interface UpdateNoteRequest {
  date?: Date;
  description?: string | null;
  lines?: NoteLineRequest[];
}

type NoteCreate = CreateDocumentInput & {
  originalId: string;
  lines: NoteLineInput[];
};
type NoteUpdate = UpdateDocumentInput & { lines?: NoteLineInput[] };

interface OriginalRow {
  id: string;
  partnerId: string;
  status: DocumentStatus;
  date: Date;
  lines: OriginalLine[];
}

/** The original document (invoice / bill) side of a note kind. Table names
 *  are constant literals, never user input (safe for Prisma.raw). */
interface OriginalSide {
  table: 'sales_invoices' | 'purchase_bills';
  lineTable: 'sales_invoice_lines' | 'purchase_bill_lines';
  lineFk: 'sales_invoice_id' | 'purchase_bill_id';
  noun: string;
  label: string;
  find(id: string): Promise<OriginalRow | null>;
}

interface NoteKind {
  spec: DocumentDescriptor<NoteRow, NoteCreate, NoteUpdate>;
  table: 'sales_credit_notes' | 'purchase_debit_notes';
  lineTable: 'sales_credit_note_lines' | 'purchase_debit_note_lines';
  original: OriginalSide;
  target: PaymentTarget;
  credit: CreditSource;
}

const LINES = { orderBy: { lineNo: 'asc' } } as const;
const APPLICATIONS = {
  orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
};

/** The original's row under its FOR UPDATE lock. */
interface LockedOriginal {
  status: string;
  total: string;
  outstanding: string;
}

/**
 * Sales credit notes (nota retur penjualan) and purchase debit notes (nota
 * retur pembelian): each returns part of ONE posted invoice / bill of the
 * same partner. Draft/list/post orchestration is the shared
 * TaxedDocumentService (a DocumentDescriptor per kind); this service adds what
 * notes need on top:
 * - lines are requested as (originalLineId, quantity) and priced from the
 *   original line (returnedLine — copied price/account/tax codes, pro-rated
 *   discount);
 * - the returnable quantity (original − every live DRAFT/POSTED note's) is
 *   enforced under the ORIGINAL's FOR UPDATE lock on create, edit and post, so
 *   concurrent notes cannot over-return;
 * - the posted journal mirrors the original's for the returned part; its
 *   settlement first settles the original (creditedAmount → the original's
 *   creditedTotal), any excess goes to the advance account as partner credit
 *   (unappliedAmount), applied later through PaymentsService.applyCredit —
 *   the same machinery as payment advances;
 * - void reverses the journal and gives the credit back to the original, once
 *   no application of the excess is live.
 * Lock order (all paths): note FOR UPDATE → partner FOR SHARE → original
 * FOR UPDATE → ledger chain — the same order as payments (holder → partner →
 * document).
 */
@Injectable()
export class NotesService {
  private readonly kinds: Record<NoteKindKey, NoteKind>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly docs: TaxedDocumentService,
    private readonly lifecycle: DocumentLifecycleService,
    private readonly payments: PaymentsService,
  ) {
    this.kinds = { SALES: this.salesKind(), PURCHASE: this.purchaseKind() };
  }

  // ---- reads ---------------------------------------------------------------

  getById(key: NoteKindKey, id: string): Promise<NoteRow> {
    return this.docs.getById(this.kinds[key].spec, id);
  }

  listPage(
    key: NoteKindKey,
    q: {
      q?: string;
      partnerId?: string;
      status?: DocumentStatus;
      limit?: number;
      offset?: number;
    },
  ) {
    return this.docs.listPage(this.kinds[key].spec, q);
  }

  // ---- drafts --------------------------------------------------------------

  async createDraft(
    key: NoteKindKey,
    req: CreateNoteRequest,
  ): Promise<NoteRow> {
    const kind = this.kinds[key];
    const original = await this.postedOriginal(kind, req.originalId);
    this.assertDateNotBeforeOriginal(req.date, original);
    return this.docs.createDraft(kind.spec, {
      originalId: original.id,
      partnerId: original.partnerId,
      date: req.date,
      description: req.description,
      lines: priceLines(kind, original, req.lines),
      createdBy: req.createdBy,
    });
  }

  async update(
    key: NoteKindKey,
    id: string,
    req: UpdateNoteRequest,
  ): Promise<NoteRow> {
    const kind = this.kinds[key];
    const note = await this.getById(key, id);
    const original = await this.postedOriginal(kind, note.originalId);
    if (req.date) this.assertDateNotBeforeOriginal(req.date, original);
    return this.docs.update(kind.spec, id, {
      date: req.date,
      description: req.description,
      lines: req.lines && priceLines(kind, original, req.lines),
    });
  }

  deleteDraft(key: NoteKindKey, id: string, deletedBy: string): Promise<void> {
    return this.docs.deleteDraft(this.kinds[key].spec, id, deletedBy);
  }

  post(key: NoteKindKey, id: string, postedBy: string): Promise<NoteRow> {
    return this.docs.post(this.kinds[key].spec, id, postedBy);
  }

  // ---- void ----------------------------------------------------------------

  /** Reverse a POSTED note's journal (dated `date`, default the note date;
   *  same not-before-own-date / not-after-today rules as every void) and give
   *  its credit back to the original. 422 HAS_APPLICATIONS while part of its
   *  excess is applied (reverse those first). */
  async void(
    key: NoteKindKey,
    id: string,
    voidedBy: string,
    date?: Date,
  ): Promise<NoteRow> {
    const kind = this.kinds[key];
    const m = documentMessages(kind.spec);
    const row = await this.getById(key, id);
    if (row.status !== 'POSTED')
      throw new ValidationFailedError(m.onlyPostedVoid, {
        id,
        status: row.status,
      });
    const voidedOn = date ?? row.date;
    if (date)
      assertNotAfterToday(date, 'Void date cannot be in the future', {
        originalDate: row.date,
      });
    assertVoidDateNotBefore(voidedOn, row.date, id);
    await this.lifecycle.reverseWithGuard({
      id,
      journalEntryId: row.journalEntryId!,
      reversedBy: voidedBy,
      reversalDate: voidedOn,
      alreadyReversedMessage: m.alreadyReversed,
      notPostedMessage: m.notPosted,
      lock: async (tx) => {
        const rows = await tx.$queryRaw<
          { status: string; credited_amount: string }[]
        >(Prisma.sql`
          SELECT status, credited_amount::text AS credited_amount
          FROM ${Prisma.raw(kind.table)}
          WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`);
        return rows[0];
      },
      applyInTx: async (tx, locked) => {
        await assertNoLiveApplicationsInTx(tx, kind.credit, id, voidedOn);
        // Voiding reopens the original's balance: like a payment void, not
        // behind a partner nobody can select any more.
        if (!(await lockLivePartnerForShare(tx, row.partnerId)))
          throw new ValidationFailedError(
            `Cannot void a ${kind.spec.noun} whose partner has been deleted`,
            { id, partnerId: row.partnerId, reason: 'PARTNER_DELETED' },
          );
        const credited = Money.of(locked.credited_amount);
        if (!credited.isZero()) {
          await this.lockOriginal(tx, kind, row.originalId);
          await tx.$executeRaw(Prisma.sql`
            UPDATE ${Prisma.raw(kind.original.table)}
            SET credited_total = credited_total - ${credited.toPersistence()}::numeric,
                updated_at = now()
            WHERE id = ${row.originalId}`);
        }
        await kind.spec.markVoid(tx, id, voidedOn);
      },
    });
    return this.getById(key, id);
  }

  // ---- partner credit (excess) ---------------------------------------------

  /** Apply part of a POSTED note's unapplied excess to invoices (credit note)
   *  / bills (debit note) of the same partner — PaymentsService.applyCredit. */
  async apply(
    key: NoteKindKey,
    id: string,
    date: Date,
    allocations: AllocationInput[],
    appliedBy: string,
  ): Promise<NoteRow> {
    const kind = this.kinds[key];
    const note = await this.getById(key, id);
    await this.payments.applyCredit(
      kind.credit,
      creditHolderOf(note),
      date,
      allocations,
      appliedBy,
    );
    return this.getById(key, id);
  }

  async reverseApplication(
    key: NoteKindKey,
    id: string,
    applicationId: string,
    reversedBy: string,
    date?: Date,
  ): Promise<NoteRow> {
    const kind = this.kinds[key];
    const note = await this.getById(key, id);
    await this.payments.reverseCreditApplication(
      kind.credit,
      creditHolderOf(note),
      applicationId,
      reversedBy,
      date,
    );
    return this.getById(key, id);
  }

  present(row: NoteRow) {
    return presentNote(row);
  }

  // ---- internals -------------------------------------------------------------

  /** The original, 404 when unknown, 422 unless POSTED (plain read; the
   *  in-tx checks re-verify it under its lock). */
  private async postedOriginal(
    kind: NoteKind,
    id: string,
  ): Promise<OriginalRow> {
    const original = await kind.original.find(id);
    if (!original)
      throw new NotFoundDomainError(`${kind.original.label} not found`, {
        id,
      });
    if (original.status !== 'POSTED')
      throw new ValidationFailedError(
        `A ${kind.spec.noun} can only return a POSTED ${kind.original.noun}`,
        { originalId: id, status: original.status },
      );
    return original;
  }

  private assertDateNotBeforeOriginal(date: Date, original: OriginalRow) {
    if (date.getTime() < original.date.getTime())
      throw new ValidationFailedError(
        'Note date cannot be before the date of the document it returns',
        {
          date: date.toISOString().slice(0, 10),
          originalId: original.id,
          originalDate: original.date.toISOString().slice(0, 10),
        },
      );
  }

  /** Lock the original FOR UPDATE: still POSTED, its outstanding. */
  private async lockOriginal(
    tx: LedgerTx,
    kind: NoteKind,
    originalId: string,
  ): Promise<LockedOriginal> {
    const [row] = await tx.$queryRaw<LockedOriginal[]>(Prisma.sql`
      SELECT status::text AS status, total::text AS total,
             (total - amount_paid - credited_total)::text AS outstanding
      FROM ${Prisma.raw(kind.original.table)}
      WHERE id = ${originalId} AND deleted_at IS NULL FOR UPDATE`);
    if (!row || row.status !== 'POSTED')
      throw new ValidationFailedError(
        `A ${kind.spec.noun} can only return a POSTED ${kind.original.noun}`,
        { originalId, status: row?.status ?? null },
      );
    return row;
  }

  /** THE over-return guard. Locks the original FOR UPDATE (serializing every
   *  note create / edit / post — and the original's void — on it), then
   *  requires, for EVERY original line, its quantity ≥ what every live
   *  (DRAFT / POSTED, not deleted) note other than `selfId` returns + what
   *  `lines` return now. 422 { originalLineId, quantity, returnable }.
   *  At post `selfId` is null and `lines` empty: the posting note's own
   *  committed lines (current under its row lock) are counted by the query. */
  private async lockReturnable(
    tx: LedgerTx,
    kind: NoteKind,
    originalId: string,
    selfId: string | null,
    lines: { originalLineId: string; quantity: Prisma.Decimal | string }[],
  ): Promise<LockedOriginal> {
    const locked = await this.lockOriginal(tx, kind, originalId);
    const rows = await tx.$queryRaw<
      { id: string; quantity: string; returned: string }[]
    >(Prisma.sql`
      SELECT ol.id, ol.quantity::text AS quantity,
             COALESCE(SUM(nl.quantity) FILTER (
               WHERE n.deleted_at IS NULL AND n.status IN ('DRAFT', 'POSTED')
                 AND n.id IS DISTINCT FROM ${selfId}::text), 0)::text AS returned
      FROM ${Prisma.raw(kind.original.lineTable)} ol
      LEFT JOIN ${Prisma.raw(kind.lineTable)} nl ON nl.original_line_id = ol.id
      LEFT JOIN ${Prisma.raw(kind.table)} n ON n.id = nl.note_id
      WHERE ol.${Prisma.raw(kind.original.lineFk)} = ${originalId}
      GROUP BY ol.id, ol.quantity`);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const asked = new Map<string, Prisma.Decimal>();
    for (const l of lines)
      asked.set(
        l.originalLineId,
        (asked.get(l.originalLineId) ?? new Prisma.Decimal(0)).add(
          l.quantity.toString(),
        ),
      );
    for (const lineId of asked.keys())
      if (!byId.has(lineId))
        throw new ValidationFailedError(
          `Returned line does not belong to the ${kind.original.noun}`,
          { originalLineId: lineId },
        );
    // EVERY original line, not only the asked ones: at post the note's own
    // (locked, current) lines are counted by the query instead of `lines`.
    for (const r of rows) {
      const qty = asked.get(r.id) ?? new Prisma.Decimal(0);
      const returned = new Prisma.Decimal(r.returned).add(qty);
      if (returned.greaterThan(r.quantity))
        throw new ValidationFailedError(
          'Returned quantity exceeds the quantity still returnable',
          {
            originalLineId: r.id,
            quantity: qty.toFixed(4),
            returnable: new Prisma.Decimal(r.quantity)
              .sub(r.returned)
              .toFixed(4),
          },
        );
    }
    return locked;
  }

  /** Post-time steps (see DocumentPostHooks), planned from the pre-lock read
   *  of the original. The settlement splits into `applied` (≤ the original's
   *  outstanding) and `excess`; under the original's lock the split must be
   *  unchanged (else the post restarts), the returnable quantities still hold
   *  and the backdated-void rule passes for the applied part. */
  private async postHooks(
    kind: NoteKind,
    row: NoteRow,
  ): Promise<DocumentPostHooks> {
    const [{ outstanding }] = await this.prisma.$queryRaw<
      { outstanding: string }[]
    >(Prisma.sql`
      SELECT (total - amount_paid - credited_total)::text AS outstanding
      FROM ${Prisma.raw(kind.original.table)} WHERE id = ${row.originalId}`);
    const [controlId, advance] = await Promise.all([
      findControlAccountId(this.prisma, kind.target.controlRole),
      this.prisma.client.account.findFirst({
        where: { role: kind.target.advanceRole },
        select: { id: true },
      }),
    ]);
    let split = { applied: '0', excess: '0' };
    return {
      journalLines: (lines) => {
        const s = lines[lines.length - 1];
        split = splitSettlement(s.debit ?? s.credit ?? '0', outstanding);
        if (!Money.of(split.excess).isZero() && !advance)
          throw new ValidationFailedError(
            'Control account missing from chart',
            {
              role: kind.target.advanceRole,
            },
          );
        return noteJournalLines(lines, controlId, {
          ...split,
          advanceAccountId: advance?.id,
        });
      },
      verifyInTx: async (tx) => {
        const locked = await this.lockReturnable(
          tx,
          kind,
          row.originalId,
          null,
          [],
        );
        const total = Money.of(split.applied).add(Money.of(split.excess));
        const now = splitSettlement(total.toPersistence(), locked.outstanding);
        if (now.applied !== split.applied) throw new DraftChangedError();
        if (!Money.of(split.applied).isZero())
          await assertNoBackdatedOverAllocation(
            tx,
            kind.target,
            { id: row.originalId, total: new Prisma.Decimal(locked.total) },
            row.date,
            split.applied,
          );
      },
      finalizeInTx: async (tx) => {
        await tx.$executeRaw(Prisma.sql`
          UPDATE ${Prisma.raw(kind.original.table)}
          SET credited_total = credited_total + ${split.applied}::numeric,
              updated_at = now()
          WHERE id = ${row.originalId}`);
        await tx.$executeRaw(Prisma.sql`
          UPDATE ${Prisma.raw(kind.table)}
          SET credited_amount = ${split.applied}::numeric,
              unapplied_amount = ${split.excess}::numeric,
              updated_at = now()
          WHERE id = ${row.id}`);
      },
    };
  }

  private salesKind(): NoteKind {
    const db = this.prisma.client;
    const kind: NoteKind = {
      table: 'sales_credit_notes',
      lineTable: 'sales_credit_note_lines',
      original: {
        table: 'sales_invoices',
        lineTable: 'sales_invoice_lines',
        lineFk: 'sales_invoice_id',
        noun: 'invoice',
        label: 'Sales invoice',
        find: (id) =>
          db.salesInvoice.findFirst({
            where: { id },
            include: { lines: true },
          }),
      },
      target: PAYMENT_TARGETS.RECEIPT,
      credit: {
        noun: 'credit note',
        table: 'sales_credit_notes',
        holderField: 'salesCreditNoteId',
        dateKey: 'noteDate',
        sourceType: 'SALES_CREDIT_NOTE',
        target: PAYMENT_TARGETS.RECEIPT,
      },
      spec: {
        noun: 'credit note',
        label: 'Sales credit note',
        article: 'a',
        partnerFlag: 'isCustomer',
        nature: 'SALE',
        controlRole: 'AR_CONTROL',
        sourceType: 'SALES_CREDIT_NOTE',
        documentType: 'CN',
        table: 'sales_credit_notes',
        trigramColumns: ['ref', 'description'],
        model: db.salesCreditNote,
        present: presentNote,
        findById: (id, tx = db) =>
          tx.salesCreditNote.findFirst({
            where: { id },
            include: { lines: LINES, applications: APPLICATIONS },
          }),
        page: async ({ where, limit, offset }) => {
          const [rows, total] = await Promise.all([
            db.salesCreditNote.findMany({
              where,
              orderBy: { createdAt: 'desc' },
              take: limit,
              skip: offset,
            }),
            db.salesCreditNote.count({ where }),
          ]);
          return { rows, total };
        },
        hydrate: (ids) =>
          db.salesCreditNote.findMany({ where: { id: { in: ids } } }),
        createRow: async (tx, common, input) => {
          await this.lockReturnable(
            tx,
            kind,
            input.originalId,
            null,
            input.lines,
          );
          return tx.salesCreditNote.create({
            data: {
              ...noteScalars(common),
              originalId: input.originalId,
              lines: {
                create: withOriginalLines(common.lines.create, input.lines),
              },
            },
            include: { lines: LINES, applications: APPLICATIONS },
          });
        },
        updateRow: async (tx, id, common, input, existing) => {
          const lines = input.lines ?? existing.lines ?? [];
          await this.lockReturnable(tx, kind, existing.originalId, id, lines);
          await tx.salesCreditNoteLine.deleteMany({ where: { noteId: id } });
          await tx.salesCreditNote.update({
            where: { id },
            data: {
              ...noteScalars(common),
              lines: { create: withOriginalLines(common.lines.create, lines) },
            },
          });
        },
        finalizePosted: async (tx, id, ctx, postedBy) => {
          await tx.salesCreditNote.update({
            where: { id },
            data: {
              status: 'POSTED',
              number: ctx.number,
              ref: ctx.ref,
              fiscalYear: ctx.fiscalYear,
              journalEntryId: ctx.entry.id,
              postedBy,
              postedAt: new Date(),
              ...ctx.totals,
            },
          });
        },
        markVoid: async (tx, id, voidedOn) => {
          await tx.salesCreditNote.update({
            where: { id },
            data: { status: 'VOID', voidedOn, unappliedAmount: 0 },
          });
        },
        postHooks: (row) => this.postHooks(kind, row),
      },
    };
    return kind;
  }

  private purchaseKind(): NoteKind {
    const db = this.prisma.client;
    const kind: NoteKind = {
      table: 'purchase_debit_notes',
      lineTable: 'purchase_debit_note_lines',
      original: {
        table: 'purchase_bills',
        lineTable: 'purchase_bill_lines',
        lineFk: 'purchase_bill_id',
        noun: 'bill',
        label: 'Purchase bill',
        find: (id) =>
          db.purchaseBill.findFirst({
            where: { id },
            include: { lines: true },
          }),
      },
      target: PAYMENT_TARGETS.DISBURSEMENT,
      credit: {
        noun: 'debit note',
        table: 'purchase_debit_notes',
        holderField: 'purchaseDebitNoteId',
        dateKey: 'noteDate',
        sourceType: 'PURCHASE_DEBIT_NOTE',
        target: PAYMENT_TARGETS.DISBURSEMENT,
      },
      spec: {
        noun: 'debit note',
        label: 'Purchase debit note',
        article: 'a',
        partnerFlag: 'isVendor',
        nature: 'PURCHASE',
        controlRole: 'AP_CONTROL',
        sourceType: 'PURCHASE_DEBIT_NOTE',
        documentType: 'DN',
        table: 'purchase_debit_notes',
        trigramColumns: ['ref', 'description'],
        model: db.purchaseDebitNote,
        present: presentNote,
        findById: (id, tx = db) =>
          tx.purchaseDebitNote.findFirst({
            where: { id },
            include: { lines: LINES, applications: APPLICATIONS },
          }),
        page: async ({ where, limit, offset }) => {
          const [rows, total] = await Promise.all([
            db.purchaseDebitNote.findMany({
              where,
              orderBy: { createdAt: 'desc' },
              take: limit,
              skip: offset,
            }),
            db.purchaseDebitNote.count({ where }),
          ]);
          return { rows, total };
        },
        hydrate: (ids) =>
          db.purchaseDebitNote.findMany({ where: { id: { in: ids } } }),
        createRow: async (tx, common, input) => {
          await this.lockReturnable(
            tx,
            kind,
            input.originalId,
            null,
            input.lines,
          );
          return tx.purchaseDebitNote.create({
            data: {
              ...noteScalars(common),
              originalId: input.originalId,
              lines: {
                create: withOriginalLines(common.lines.create, input.lines),
              },
            },
            include: { lines: LINES, applications: APPLICATIONS },
          });
        },
        updateRow: async (tx, id, common, input, existing) => {
          const lines = input.lines ?? existing.lines ?? [];
          await this.lockReturnable(tx, kind, existing.originalId, id, lines);
          await tx.purchaseDebitNoteLine.deleteMany({ where: { noteId: id } });
          await tx.purchaseDebitNote.update({
            where: { id },
            data: {
              ...noteScalars(common),
              lines: { create: withOriginalLines(common.lines.create, lines) },
            },
          });
        },
        finalizePosted: async (tx, id, ctx, postedBy) => {
          await tx.purchaseDebitNote.update({
            where: { id },
            data: {
              status: 'POSTED',
              number: ctx.number,
              ref: ctx.ref,
              fiscalYear: ctx.fiscalYear,
              journalEntryId: ctx.entry.id,
              postedBy,
              postedAt: new Date(),
              ...ctx.totals,
            },
          });
        },
        markVoid: async (tx, id, voidedOn) => {
          await tx.purchaseDebitNote.update({
            where: { id },
            data: { status: 'VOID', voidedOn, unappliedAmount: 0 },
          });
        },
        postHooks: (row) => this.postHooks(kind, row),
      },
    };
    return kind;
  }
}

/** Price the requested lines from the original's (422 for a line of another
 *  document, a repeated line or a non-positive quantity). The returnable
 *  quantity itself is checked under the original's lock (lockReturnable). */
function priceLines(
  kind: NoteKind,
  original: OriginalRow,
  requested: NoteLineRequest[],
): NoteLineInput[] {
  const seen = new Set<string>();
  return requested.map((r) => {
    const orig = original.lines.find((l) => l.id === r.originalLineId);
    if (!orig)
      throw new ValidationFailedError(
        `Returned line does not belong to the ${kind.original.noun}`,
        { originalLineId: r.originalLineId },
      );
    if (seen.has(r.originalLineId))
      throw new ValidationFailedError(
        'Each original line may be returned at most once per note',
        { originalLineId: r.originalLineId },
      );
    seen.add(r.originalLineId);
    if (Money.of(r.quantity).isZero())
      throw new ValidationFailedError('Returned quantity must be positive', {
        originalLineId: r.originalLineId,
      });
    return returnedLine(orig, r.quantity);
  });
}

/** The note columns of the shared create/update data (notes have no due date). */
function noteScalars<
  T extends { lines: unknown; dueDate?: unknown; partnerId?: string },
>(common: T): Omit<T, 'lines' | 'dueDate'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { lines, dueDate, ...scalars } = common;
  return scalars;
}

/** Attach each priced line's originalLineId (same order as `lines`). */
function withOriginalLines(
  create: DocumentLineCreateData[],
  lines: { originalLineId: string }[],
): (DocumentLineCreateData & { originalLineId: string })[] {
  return create.map((l, i) => ({
    ...l,
    originalLineId: lines[i].originalLineId,
  }));
}

/** API shape of a note: 4dp money strings (lines and applications too). */
export function presentNote(row: NoteRow) {
  const { lines, applications } = row;
  return {
    ...serializeMoney(row, [
      'subtotal',
      'taxTotal',
      'withholdingTotal',
      'total',
      'discountTotal',
      'creditedAmount',
      'unappliedAmount',
    ]),
    ...(lines
      ? {
          lines: lines.map((l) =>
            serializeMoney(l, [
              'quantity',
              'unitPrice',
              'discountPercent',
              'discountAmount',
              'amount',
            ]),
          ),
        }
      : {}),
    ...(applications
      ? { applications: applications.map((a) => serializeMoney(a, ['amount'])) }
      : {}),
  };
}
