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
import { lockLiveRow } from '../common/db/lock-live-row';
import { serializeMoney } from '../common/money/serialize-money';
import {
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';
import { DocumentLifecycleService } from '../ledger/document-lifecycle.service';
import { TaxedDocumentService } from './taxed-document.service';
import {
  DocumentPostingService,
  DraftChangedError,
} from './document-posting.service';
import {
  CreateDocumentInput,
  DocumentDescriptor,
  DocumentLineCreateData,
  DocumentPostHooks,
  UpdateDocumentInput,
} from './document-descriptor';
import { buildLineCreateData, documentMessages } from './document-presenter';
import {
  assertVoidDateNotBefore,
  discountTotal,
  findControlAccountId,
  taxableLines,
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
  CreditRefundInput,
  splitCreditUses,
} from './payments.service';
import { lockLivePartnerForShare } from './partner-lock';
import {
  NoteLineInput,
  NoteTaxPlan,
  OriginalLine,
  completedLine,
  noteJournalLines,
  noteTaxAmounts,
  noteTaxPlan,
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

/** A returned (originalLineId, quantity) pair. */
interface ReturnedQuantity {
  originalLineId: string;
  quantity: Prisma.Decimal | string;
}

/** What readReturnState reads: per original line (quantity, amount, codes,
 *  and what other live notes return of it), and those notes. */
interface ReturnState {
  lines: {
    id: string;
    quantity: string;
    amount: string;
    taxCodeIds: string[];
    returned: string;
    returnedAmount: string;
  }[];
  others: {
    taxTotal: string;
    withholdingTotal: string;
    lines: { amount: string; taxCodeIds: string[] }[];
  }[];
}

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
 *   concurrent notes cannot over-return; under the same lock a note that
 *   completes a line / tax code takes the original's remainder, and partial
 *   tax is capped at it (priceUnderLock, noteTaxPlan) — whole returns sum to
 *   the original exactly;
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
    private readonly docPosting: DocumentPostingService,
  ) {
    this.kinds = {
      SALES: this.noteKind(NOTE_KINDS.SALES),
      PURCHASE: this.noteKind(NOTE_KINDS.PURCHASE),
    };
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
      lock: (tx) =>
        lockLiveRow<{ status: string; credited_amount: string }>(
          tx,
          kind.table,
          id,
          'status, credited_amount::text AS credited_amount',
        ),
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

  /** Refund part of a POSTED note's unapplied excess in cash —
   *  PaymentsService.refundCredit. */
  async refund(
    key: NoteKindKey,
    id: string,
    refund: CreditRefundInput,
    refundedBy: string,
  ): Promise<NoteRow> {
    const note = await this.getById(key, id);
    await this.payments.refundCredit(
      this.kinds[key].credit,
      creditHolderOf(note),
      refund,
      refundedBy,
    );
    return this.getById(key, id);
  }

  async reverseRefund(
    key: NoteKindKey,
    id: string,
    refundId: string,
    reversedBy: string,
    date?: Date,
  ): Promise<NoteRow> {
    const note = await this.getById(key, id);
    await this.payments.reverseCreditApplication(
      this.kinds[key].credit,
      creditHolderOf(note),
      refundId,
      reversedBy,
      date,
      'refund',
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
    const row = await lockLiveRow<LockedOriginal>(
      tx,
      kind.original.table,
      originalId,
      'status::text AS status, total::text AS total, (total - amount_paid - credited_total)::text AS outstanding',
    );
    if (!row || row.status !== 'POSTED')
      throw new ValidationFailedError(
        `A ${kind.spec.noun} can only return a POSTED ${kind.original.noun}`,
        { originalId, status: row?.status ?? null },
      );
    return row;
  }

  /** Per original line: its quantity/amount/codes and what every OTHER live
   *  (DRAFT / POSTED, not deleted) note returns of it; and those notes' lines
   *  + stored PPN/PPh totals (the tax plan input). Plain reads — under the
   *  original's lock when called from lockReturnable. */
  private async readReturnState(
    db: LedgerTx,
    kind: NoteKind,
    originalId: string,
    selfId: string | null,
  ): Promise<ReturnState> {
    const live = Prisma.sql`n.deleted_at IS NULL AND n.status IN ('DRAFT', 'POSTED')
      AND n.id IS DISTINCT FROM ${selfId}::text`;
    const [lines, others] = await Promise.all([
      db.$queryRaw<ReturnState['lines']>(Prisma.sql`
        SELECT ol.id, ol.quantity::text AS quantity, ol.amount::text AS amount,
               ol.tax_code_ids AS "taxCodeIds",
               COALESCE(SUM(nl.quantity) FILTER (WHERE ${live}), 0)::text AS returned,
               COALESCE(SUM(nl.amount) FILTER (WHERE ${live}), 0)::text AS "returnedAmount"
        FROM ${Prisma.raw(kind.original.lineTable)} ol
        LEFT JOIN ${Prisma.raw(kind.lineTable)} nl ON nl.original_line_id = ol.id
        LEFT JOIN ${Prisma.raw(kind.table)} n ON n.id = nl.note_id
        WHERE ol.${Prisma.raw(kind.original.lineFk)} = ${originalId}
        GROUP BY ol.id, ol.quantity, ol.amount, ol.tax_code_ids`),
      db.$queryRaw<
        {
          id: string;
          taxTotal: string;
          withholdingTotal: string;
          amount: string;
          taxCodeIds: string[];
        }[]
      >(Prisma.sql`
        SELECT n.id, n.tax_total::text AS "taxTotal",
               n.withholding_total::text AS "withholdingTotal",
               nl.amount::text AS amount, nl.tax_code_ids AS "taxCodeIds"
        FROM ${Prisma.raw(kind.table)} n
        JOIN ${Prisma.raw(kind.lineTable)} nl ON nl.note_id = n.id
        WHERE n.original_id = ${originalId} AND ${live}
        ORDER BY n.id, nl.line_no`),
    ]);
    const byNote = new Map<string, ReturnState['others'][number]>();
    for (const r of others) {
      const o = byNote.get(r.id) ?? {
        taxTotal: r.taxTotal,
        withholdingTotal: r.withholdingTotal,
        lines: [],
      };
      o.lines.push({ amount: r.amount, taxCodeIds: r.taxCodeIds });
      byNote.set(r.id, o);
    }
    return { lines, others: [...byNote.values()] };
  }

  /** THE over-return guard. Locks the original FOR UPDATE (serializing every
   *  note create / edit / post — and the original's void — on it), then
   *  requires, for EVERY original line, its quantity ≥ what every live
   *  (DRAFT / POSTED, not deleted) note other than `selfId` returns + what
   *  `lines` return now. 422 { originalLineId, quantity, returnable }.
   *  Returns the locked original and the return state read under the lock
   *  (the remainder / cap inputs: priceUnderLock, taxPlan). */
  private async lockReturnable(
    tx: LedgerTx,
    kind: NoteKind,
    originalId: string,
    selfId: string | null,
    lines: ReturnedQuantity[],
  ): Promise<{ locked: LockedOriginal; state: ReturnState }> {
    const locked = await this.lockOriginal(tx, kind, originalId);
    const state = await this.readReturnState(tx, kind, originalId, selfId);
    const byId = new Map(state.lines.map((r) => [r.id, r]));
    const asked = askedQuantities(lines);
    for (const lineId of asked.keys())
      if (!byId.has(lineId))
        throw new ValidationFailedError(
          `Returned line does not belong to the ${kind.original.noun}`,
          { originalLineId: lineId },
        );
    for (const r of state.lines) {
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
    return { locked, state };
  }

  /** The note's per-code tax plan (noteTaxPlan) for `lines` against `state`;
   *  rates/kinds read through `db` (inactive codes included). */
  private async taxPlan(
    db: LedgerTx,
    state: ReturnState,
    lines: ReturnedQuantity[],
  ): Promise<NoteTaxPlan> {
    const ids = [...new Set(state.lines.flatMap((l) => l.taxCodeIds))];
    const codes = await db.taxCode.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, rate: true, kind: true },
    });
    const asked = askedQuantities(lines);
    return noteTaxPlan({
      codes: new Map(
        codes.map((c) => [c.id, { rate: c.rate.toString(), kind: c.kind }]),
      ),
      original: state.lines.map((l) => ({
        amount: l.amount,
        taxCodeIds: l.taxCodeIds,
        complete: new Prisma.Decimal(l.returned)
          .add(asked.get(l.id) ?? 0)
          .equals(l.quantity),
      })),
      others: state.others,
    });
  }

  /** Create / edit, under the original's lock: the lines and totals stored
   *  on the draft. A line brought to its full quantity takes its remainder
   *  (completedLine) and the tax follows the plan (remainder when complete,
   *  else capped) — replacing the pre-lock totals TaxedDocumentService
   *  computed, so two concurrent notes cannot both take a remainder. */
  private async priceUnderLock(
    tx: LedgerTx,
    kind: NoteKind,
    originalId: string,
    selfId: string | null,
    requested: NoteLineInput[],
  ) {
    const { state } = await this.lockReturnable(
      tx,
      kind,
      originalId,
      selfId,
      requested,
    );
    const byId = new Map(state.lines.map((r) => [r.id, r]));
    const lines = requested.map((l) => {
      const r = byId.get(l.originalLineId)!;
      return new Prisma.Decimal(r.returned).add(l.quantity).equals(r.quantity)
        ? completedLine(
            l,
            Money.of(r.amount)
              .subtract(Money.of(r.returnedAmount))
              .toPersistence(),
          )
        : l;
    });
    const plan = await this.taxPlan(tx, state, lines);
    const totals = await this.docPosting.computeTotals(
      kind.spec.nature,
      await findControlAccountId(this.prisma, kind.spec.controlRole),
      taxableLines(lines),
      tx,
      {
        allowInactiveCodes: true,
        overrideAmounts: (raw) => noteTaxAmounts(raw, plan),
      },
    );
    return {
      ...totals,
      discountTotal: discountTotal(lines),
      lines: withOriginalLines(buildLineCreateData(lines), lines),
    };
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
    // The tax plan, from this attempt's (unlocked) read; re-derived under the
    // original's lock in verifyInTx and must be unchanged (else restart).
    const noteLines = row.lines ?? [];
    const plan = await this.taxPlan(
      this.prisma.client,
      await this.readReturnState(
        this.prisma.client,
        kind,
        row.originalId,
        row.id,
      ),
      noteLines,
    );
    let split = { applied: '0', excess: '0' };
    return {
      overrideTaxAmounts: (raw) => noteTaxAmounts(raw, plan),
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
        // The note's own lines are current here (verified under its row lock
        // before this hook runs).
        const { locked, state } = await this.lockReturnable(
          tx,
          kind,
          row.originalId,
          row.id,
          noteLines,
        );
        if (!samePlan(plan, await this.taxPlan(tx, state, noteLines)))
          throw new DraftChangedError();
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

  /** One note kind's descriptor + credit source, from its constants. Both
   *  kinds' tables have the same columns, so one (sales) delegate type serves
   *  both (the per-kind Prisma model is picked by name). */
  private noteKind(cfg: NoteKindConfig): NoteKind {
    const db = this.prisma.client;
    const notes = (c: LedgerTx) => c[cfg.model] as unknown as NoteDelegate;
    const noteLines = (c: LedgerTx) =>
      c[cfg.lineModel] as unknown as LedgerTx['salesCreditNoteLine'];
    const { model: originalModel, ...original } = cfg.original;
    const kind: NoteKind = {
      table: cfg.table,
      lineTable: cfg.lineTable,
      original: {
        ...original,
        find: (id) =>
          (db[originalModel] as unknown as LedgerTx['salesInvoice']).findFirst({
            where: { id },
            include: { lines: true },
          }),
      },
      target: cfg.target,
      credit: {
        noun: cfg.noun,
        table: cfg.table,
        holderField: cfg.holderField,
        dateKey: 'noteDate',
        sourceType: cfg.sourceType,
        target: cfg.target,
      },
      spec: {
        noun: cfg.noun,
        label: cfg.label,
        article: 'a',
        partnerFlag: cfg.partnerFlag,
        allowInactiveRefs: true,
        nature: cfg.nature,
        controlRole: cfg.controlRole,
        sourceType: cfg.sourceType,
        documentType: cfg.documentType,
        table: cfg.table,
        trigramColumns: ['ref', 'description'],
        model: notes(db),
        present: presentNote,
        findById: (id, tx = db) =>
          notes(tx).findFirst({
            where: { id },
            include: { lines: LINES, applications: APPLICATIONS },
          }),
        createRow: async (tx, common, input) => {
          const { lines, ...priced } = await this.priceUnderLock(
            tx,
            kind,
            input.originalId,
            null,
            input.lines,
          );
          return notes(tx).create({
            data: {
              ...noteScalars(common),
              ...priced,
              originalId: input.originalId,
              lines: { create: lines },
            },
            include: { lines: LINES, applications: APPLICATIONS },
          });
        },
        updateRow: async (tx, id, common, input, existing) => {
          const { lines, ...priced } = await this.priceUnderLock(
            tx,
            kind,
            existing.originalId,
            id,
            input.lines ?? (existing.lines ?? []).map(storedNoteLine),
          );
          await noteLines(tx).deleteMany({ where: { noteId: id } });
          await notes(tx).update({
            where: { id },
            data: {
              ...noteScalars(common),
              ...priced,
              lines: { create: lines },
            },
          });
        },
        finalizePosted: async (tx, id, ctx, postedBy) => {
          await notes(tx).update({
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
          await notes(tx).update({
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

type NoteDelegate = LedgerTx['salesCreditNote'];

/** What differs between the two note kinds — constant literals only (the
 *  table names go into Prisma.raw). */
interface NoteKindConfig {
  noun: 'credit note' | 'debit note';
  label: string;
  partnerFlag: 'isCustomer' | 'isVendor';
  nature: 'SALE' | 'PURCHASE';
  controlRole: 'AR_CONTROL' | 'AP_CONTROL';
  sourceType: 'SALES_CREDIT_NOTE' | 'PURCHASE_DEBIT_NOTE';
  documentType: 'CN' | 'DN';
  table: NoteKind['table'];
  lineTable: NoteKind['lineTable'];
  holderField: 'salesCreditNoteId' | 'purchaseDebitNoteId';
  /** Prisma delegate names (same columns in both kinds). */
  model: 'salesCreditNote' | 'purchaseDebitNote';
  lineModel: 'salesCreditNoteLine' | 'purchaseDebitNoteLine';
  original: Omit<OriginalSide, 'find'> & {
    model: 'salesInvoice' | 'purchaseBill';
  };
  target: PaymentTarget;
}

const NOTE_KINDS: Record<NoteKindKey, NoteKindConfig> = {
  SALES: {
    noun: 'credit note',
    label: 'Sales credit note',
    partnerFlag: 'isCustomer',
    nature: 'SALE',
    controlRole: 'AR_CONTROL',
    sourceType: 'SALES_CREDIT_NOTE',
    documentType: 'CN',
    table: 'sales_credit_notes',
    lineTable: 'sales_credit_note_lines',
    holderField: 'salesCreditNoteId',
    model: 'salesCreditNote',
    lineModel: 'salesCreditNoteLine',
    original: {
      model: 'salesInvoice',
      table: 'sales_invoices',
      lineTable: 'sales_invoice_lines',
      lineFk: 'sales_invoice_id',
      noun: 'invoice',
      label: 'Sales invoice',
    },
    target: PAYMENT_TARGETS.RECEIPT,
  },
  PURCHASE: {
    noun: 'debit note',
    label: 'Purchase debit note',
    partnerFlag: 'isVendor',
    nature: 'PURCHASE',
    controlRole: 'AP_CONTROL',
    sourceType: 'PURCHASE_DEBIT_NOTE',
    documentType: 'DN',
    table: 'purchase_debit_notes',
    lineTable: 'purchase_debit_note_lines',
    holderField: 'purchaseDebitNoteId',
    model: 'purchaseDebitNote',
    lineModel: 'purchaseDebitNoteLine',
    original: {
      model: 'purchaseBill',
      table: 'purchase_bills',
      lineTable: 'purchase_bill_lines',
      lineFk: 'purchase_bill_id',
      noun: 'bill',
      label: 'Purchase bill',
    },
    target: PAYMENT_TARGETS.DISBURSEMENT,
  },
};

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

/** Total returned quantity per original line. */
function askedQuantities(
  lines: ReturnedQuantity[],
): Map<string, Prisma.Decimal> {
  const asked = new Map<string, Prisma.Decimal>();
  for (const l of lines)
    asked.set(
      l.originalLineId,
      (asked.get(l.originalLineId) ?? new Prisma.Decimal(0)).add(
        l.quantity.toString(),
      ),
    );
  return asked;
}

function samePlan(a: NoteTaxPlan, b: NoteTaxPlan): boolean {
  const ka = Object.keys(a);
  return (
    ka.length === Object.keys(b).length &&
    ka.every(
      (k) =>
        b[k] !== undefined &&
        a[k].complete === b[k].complete &&
        Money.of(a[k].remaining).equals(Money.of(b[k].remaining)),
    )
  );
}

/** A stored note line as a priced line (an edit that keeps its lines). */
function storedNoteLine(l: SalesCreditNoteLine): NoteLineInput {
  return {
    originalLineId: l.originalLineId,
    description: l.description,
    accountId: l.accountId,
    quantity: l.quantity.toString(),
    unitPrice: l.unitPrice.toString(),
    discountPercent: l.discountPercent?.toString() ?? null,
    discountAmount: l.discountAmount.toString(),
    taxCodeIds: l.taxCodeIds,
  };
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
    ...(applications ? splitCreditUses(applications) : {}),
  };
}
