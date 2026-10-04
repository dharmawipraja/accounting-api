import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { LedgerTx } from '../common/prisma/prisma.service';
import { BalancesService } from '../ledger/balances/balances.service';
import { settlementsSql } from '../invoicing/payment-targets';
import {
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';
import { GL_MAX_LINES } from './general-ledger.service';
import {
  runStatement,
  StatementEvent,
  StatementSide,
} from './partner-statement';

/** Per-side constants — never user input (safe for Prisma.raw). */
const SIDES = {
  customer: {
    docs: 'sales_invoices',
    refCol: 'invoice_ref',
    notes: 'sales_credit_notes',
    noteCol: 'sales_credit_note_id',
    direction: 'RECEIPT',
    docType: 'INVOICE',
    noteType: 'CREDIT_NOTE',
    flag: 'is_customer',
  },
  vendor: {
    docs: 'purchase_bills',
    refCol: 'bill_ref',
    notes: 'purchase_debit_notes',
    noteCol: 'purchase_debit_note_id',
    direction: 'DISBURSEMENT',
    docType: 'BILL',
    noteType: 'DEBIT_NOTE',
    flag: 'is_vendor',
  },
} as const;

interface EventRow {
  date: Date;
  type: string;
  ref: string | null;
  document_ref: string | null;
  description: string | null;
  doc_delta: Prisma.Decimal;
  credit_delta: Prisma.Decimal;
  document_id: string | null;
  payment_id: string | null;
  note_id: string | null;
  application_id: string | null;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

@Injectable()
export class PartnerStatementService {
  constructor(private readonly balances: BalancesService) {}

  /**
   * Kartu piutang (customer) / kartu hutang (vendor) for one partner over
   * [from, to]. Every event is placed on its own as-of date with the SAME
   * live-window semantics as the aging (settlementsSql): a document counts
   * from its date and is reversed on its voided_on; a payment / note / credit
   * application / refund likewise on [date, voided_on | reversed_on). So the
   * closing balance as of `to` equals the partner's AR/AP aging total as of
   * `to`, and the unapplied credit equals the partner's share of the advance
   * account. All reads share one snapshot.
   */
  async generate(
    partnerId: string,
    side: StatementSide,
    from: Date,
    to: Date,
    maxLines = GL_MAX_LINES,
  ) {
    return this.balances.snapshot(async (tx) => {
      const partner = await this.partnerFor(tx, partnerId, side);
      const ev = this.eventsSql(partnerId, side);
      const [opening] = await tx.$queryRaw<
        { doc: Prisma.Decimal; credit: Prisma.Decimal }[]
      >(Prisma.sql`
        WITH ${ev}
        SELECT COALESCE(SUM(doc_delta), 0) AS doc,
               COALESCE(SUM(credit_delta), 0) AS credit
        FROM ev WHERE date < ${ymd(from)}::date`);
      const rows = await tx.$queryRaw<EventRow[]>(Prisma.sql`
        WITH ${ev}
        SELECT date, type, ref, document_ref, description, doc_delta,
               credit_delta, document_id, payment_id, note_id, application_id
        FROM ev WHERE date BETWEEN ${ymd(from)}::date AND ${ymd(to)}::date
        ORDER BY date, rank, at, tie
        LIMIT ${maxLines + 1}`);
      if (rows.length > maxLines)
        throw new ValidationFailedError(
          `Statement has more than ${maxLines} lines; narrow the date range`,
          { from: ymd(from), to: ymd(to) },
        );
      const events: StatementEvent[] = rows.map((r) => ({
        date: ymd(r.date),
        type: r.type,
        ref: r.ref,
        documentRef: r.document_ref,
        description: r.description,
        docDelta: r.doc_delta.toString(),
        creditDelta: r.credit_delta.toString(),
        documentId: r.document_id,
        paymentId: r.payment_id,
        noteId: r.note_id,
        applicationId: r.application_id,
      }));
      return {
        partner,
        side,
        from: ymd(from),
        to: ymd(to),
        ...runStatement(
          side,
          {
            docBalance: opening.doc.toString(),
            unappliedCredit: opening.credit.toString(),
          },
          events,
        ),
      };
    });
  }

  /** 404 when the partner does not exist or is soft-deleted. 422 unless it
   *  carries the side's role flag now OR did historically — i.e. has any
   *  posted/voided document, payment or note on that side (the flag can be
   *  cleared once nothing is open). */
  private async partnerFor(tx: LedgerTx, id: string, side: StatementSide) {
    const s = SIDES[side];
    const rows = await tx.$queryRaw<
      { id: string; code: string; name: string; has_role: boolean }[]
    >(Prisma.sql`
      SELECT bp.id, bp.code, bp.name,
        (bp.${Prisma.raw(s.flag)}
         OR EXISTS (SELECT 1 FROM ${Prisma.raw(s.docs)} d WHERE d.partner_id = bp.id
                      AND d.deleted_at IS NULL AND d.status <> 'DRAFT')
         OR EXISTS (SELECT 1 FROM payments p WHERE p.partner_id = bp.id
                      AND p.direction = ${s.direction}::"PaymentDirection"
                      AND p.deleted_at IS NULL AND p.status <> 'DRAFT')) AS has_role
      FROM business_partners bp
      WHERE bp.id = ${id} AND bp.deleted_at IS NULL`);
    if (rows.length === 0)
      throw new NotFoundDomainError('Business partner not found', { id });
    if (!rows[0].has_role)
      throw new ValidationFailedError(
        `Partner is not a ${side} (now or historically)`,
        { partnerId: id, side },
      );
    return { id: rows[0].id, code: rows[0].code, name: rows[0].name };
  }

  /** CTE `ev`: every event of the partner on this side, one row per as-of
   *  movement — doc_delta on the AR/AP balance, credit_delta on unapplied
   *  credit (sign: + increases). Originals sort before same-day reversals. */
  private eventsSql(partnerId: string, side: StatementSide): Prisma.Sql {
    const s = SIDES[side];
    const docs = Prisma.raw(s.docs);
    const notes = Prisma.raw(s.notes);
    const ref = Prisma.raw(`d.${s.refCol}`);
    const noteCol = Prisma.raw(`ap.${s.noteCol}`);
    const docType = Prisma.sql`${s.docType}::text`;
    const noteType = Prisma.sql`${s.noteType}::text`;
    const live = (a: string) =>
      Prisma.raw(
        `${a}.status IN ('POSTED', 'VOID') AND ${a}.deleted_at IS NULL`,
      );
    return Prisma.sql`
      settled AS (
        SELECT st.* FROM (${settlementsSql(s.docs)}) st
        JOIN ${docs} d ON d.id = st.document_id
        WHERE d.partner_id = ${partnerId}
      ),
      docs AS (
        SELECT * FROM ${docs} x WHERE x.partner_id = ${partnerId} AND ${live('x')}
      ),
      pays AS (
        SELECT p.*, COALESCE((SELECT SUM(x.amount) FROM settled x
                   WHERE x.kind = 'ALLOCATION' AND x.payment_id = p.id), 0) AS alloc
        FROM payments p
        WHERE p.partner_id = ${partnerId}
          AND p.direction = ${s.direction}::"PaymentDirection" AND ${live('p')}
      ),
      nts AS (
        SELECT n.*, o.${Prisma.raw(s.refCol)} AS original_ref,
               COALESCE((SELECT SUM(x.amount) FROM settled x
                   WHERE x.kind = 'NOTE' AND x.note_id = n.id), 0) AS credited
        FROM ${notes} n JOIN ${docs} o ON o.id = n.original_id
        WHERE n.partner_id = ${partnerId} AND ${live('n')}
      ),
      refunds AS (
        SELECT ap.*, COALESCE(q.ref, n.ref) AS source_ref,
               ${noteCol} AS note_id
        FROM payment_applications ap
        LEFT JOIN pays q ON q.id = ap.payment_id
        LEFT JOIN nts n ON n.id = ${noteCol}
        WHERE ap.cash_account_id IS NOT NULL AND (q.id IS NOT NULL OR n.id IS NOT NULL)
      ),
      ev AS (
        SELECT d.date, 0 AS rank, d.posted_at AS at, d.id AS tie,
               ${docType} AS type, ${ref} AS ref, ${ref} AS document_ref,
               d.description, d.total AS doc_delta, 0::numeric AS credit_delta,
               d.id AS document_id, NULL::text AS payment_id,
               NULL::text AS note_id, NULL::text AS application_id
        FROM docs d
        UNION ALL
        SELECT d.voided_on, 1, d.posted_at, d.id, ${docType} || '_VOID', ${ref},
               ${ref}, d.description, -d.total, 0, d.id, NULL, NULL, NULL
        FROM docs d WHERE d.status = 'VOID'
        UNION ALL
        SELECT p.date, 0, p.posted_at, p.id,
               CASE WHEN p.opening THEN 'OPENING_CREDIT' ELSE 'PAYMENT' END,
               p.ref, NULL, p.description, -p.alloc, p.amount - p.alloc,
               NULL, p.id, NULL, NULL
        FROM pays p
        UNION ALL
        SELECT p.voided_on, 1, p.posted_at, p.id,
               CASE WHEN p.opening THEN 'OPENING_CREDIT_VOID' ELSE 'PAYMENT_VOID' END,
               p.ref, NULL, p.description, p.alloc, -(p.amount - p.alloc),
               NULL, p.id, NULL, NULL
        FROM pays p WHERE p.status = 'VOID'
        UNION ALL
        SELECT n.date, 0, n.posted_at, n.id, ${noteType}, n.ref, n.original_ref,
               n.description, -n.credited, n.total - n.credited,
               n.original_id, NULL, n.id, NULL
        FROM nts n
        UNION ALL
        SELECT n.voided_on, 1, n.posted_at, n.id, ${noteType} || '_VOID', n.ref,
               n.original_ref, n.description, n.credited, -(n.total - n.credited),
               n.original_id, NULL, n.id, NULL
        FROM nts n WHERE n.status = 'VOID'
        UNION ALL
        SELECT x.date, 0, ap.created_at, x.application_id, 'CREDIT_APPLICATION',
               x.ref, ${ref}, NULL, -x.amount, -x.amount,
               x.document_id, x.payment_id, x.note_id, x.application_id
        FROM settled x
        JOIN payment_applications ap ON ap.id = x.application_id
        JOIN ${docs} d ON d.id = x.document_id
        WHERE x.kind = 'APPLICATION'
        UNION ALL
        SELECT x.voided_on, 1, ap.created_at, x.application_id,
               'CREDIT_APPLICATION_REVERSAL', x.ref, ${ref}, NULL, x.amount, x.amount,
               x.document_id, x.payment_id, x.note_id, x.application_id
        FROM settled x
        JOIN payment_applications ap ON ap.id = x.application_id
        JOIN ${docs} d ON d.id = x.document_id
        WHERE x.kind = 'APPLICATION' AND x.status = 'VOID'
        UNION ALL
        SELECT r.date, 0, r.created_at, r.id, 'REFUND', r.source_ref, NULL, NULL,
               0, -r.amount, NULL, r.payment_id, r.note_id, r.id
        FROM refunds r
        UNION ALL
        SELECT r.reversed_on, 1, r.created_at, r.id, 'REFUND_REVERSAL',
               r.source_ref, NULL, NULL, 0, r.amount,
               NULL, r.payment_id, r.note_id, r.id
        FROM refunds r WHERE r.reversed_on IS NOT NULL
      )`;
  }
}
