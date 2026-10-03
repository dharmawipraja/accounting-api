import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import { truncateToUtcDay } from '../common/dates/utc-day';
import { settlementsSql } from '../invoicing/payment-targets';
import { ValidationFailedError } from '../common/errors/domain-errors';

/** One row per included open document, LEFT JOINed onto the one-row totals
 *  aggregate: when no document is included (none open, or the cap cut before
 *  the first partner) a single all-null document row still carries totals. */
interface AgingRow {
  id: string | null;
  ref: string | null;
  partner_id: string | null;
  partner_name: string | null;
  date: Date | null;
  due_date: Date | null;
  total: Prisma.Decimal | null;
  paid_as_of: Prisma.Decimal | null;
  outstanding: Prisma.Decimal | null;
  bucket: string | null;
  doc_count: bigint;
  page_doc_count: bigint;
  t_current: Prisma.Decimal;
  t_1_30: Prisma.Decimal;
  t_31_60: Prisma.Decimal;
  t_61_90: Prisma.Decimal;
  t_over_90: Prisma.Decimal;
  t_all: Prisma.Decimal;
}

const BUCKETS = ['Current', '1-30', '31-60', '61-90', '>90'] as const;

/** Hard per-request document cap — the open-item set is small in practice,
 *  but the query must not be able to materialize unbounded history. */
export const AGING_MAX_DOCS = 10_000;

@Injectable()
export class AgingService {
  constructor(private readonly prisma: PrismaService) {}

  /** kind: 'AR' (sales_invoices + sales_invoice_id) | 'AP' (purchase_bills + purchase_bill_id).
   *  `afterPartnerId` continues a truncated report: only partners ordered
   *  after it (by name, id) are listed. Totals always cover the whole report. */
  async aging(
    kind: 'AR' | 'AP',
    asOf: Date,
    afterPartnerId?: string,
    maxDocs = AGING_MAX_DOCS,
  ) {
    const day = truncateToUtcDay(asOf);
    let after = Prisma.sql`true`;
    if (afterPartnerId) {
      const p = await this.prisma.$queryRaw<{ name: string }[]>`
        SELECT name FROM business_partners WHERE id = ${afterPartnerId}`;
      if (p.length === 0)
        throw new ValidationFailedError('afterPartnerId is not a partner', {
          afterPartnerId,
        });
      after = Prisma.sql`(o.partner_name, o.partner_id) > (${p[0].name}, ${afterPartnerId})`;
    }
    const docTable =
      kind === 'AR'
        ? Prisma.raw('sales_invoices')
        : Prisma.raw('purchase_bills');
    const refCol =
      kind === 'AR' ? Prisma.raw('d.invoice_ref') : Prisma.raw('d.bill_ref');

    // As-of semantics: a document/payment is live on `day` if it was posted
    // dated on/before it and not voided on/before it (voided_on is the void's
    // reversal date, which may be later than the document date); a later
    // application of a payment's advance likewise on [date, reversed_on) — see
    // settlementsSql. This keeps the subledger tied to the control account for
    // every as-of date. Unapplied advances are NOT AR/AP (they sit on the
    // advance accounts), so they never appear here.
    // Fully-paid documents are filtered in SQL (not JS) so only genuinely open
    // items are materialized. ONE statement (so one consistent snapshot):
    // - totals are aggregated over EVERY open document, whatever the cap;
    // - the cap cuts only at partner boundaries: `through_partner` counts the
    //   documents up to and including the row's whole partner (RANGE frame:
    //   peers = same partner), so a partner is either fully in or fully out;
    // - `afterPartnerId` only narrows `ranked` (the listed page), never totals.
    const rows = await this.prisma.$queryRaw<AgingRow[]>(Prisma.sql`
      WITH open_docs AS (
        SELECT doc.*, doc.total - doc.paid_as_of AS outstanding,
               CASE
                 WHEN ${day}::date - COALESCE(doc.due_date, doc.date) <= 0 THEN 'Current'
                 WHEN ${day}::date - COALESCE(doc.due_date, doc.date) <= 30 THEN '1-30'
                 WHEN ${day}::date - COALESCE(doc.due_date, doc.date) <= 60 THEN '31-60'
                 WHEN ${day}::date - COALESCE(doc.due_date, doc.date) <= 90 THEN '61-90'
                 ELSE '>90'
               END AS bucket
        FROM (
          SELECT d.id, ${refCol} AS ref,
                 d.partner_id, bp.name AS partner_name, d.date, d.due_date, d.total,
                 COALESCE((
                   SELECT SUM(st.amount) FROM (${settlementsSql(kind === 'AR' ? 'sales_invoices' : 'purchase_bills')}) st
                   WHERE st.document_id = d.id AND st.date <= ${day}
                     AND (st.status = 'POSTED' OR st.voided_on > ${day})
                 ), 0) AS paid_as_of
          FROM ${docTable} d
          JOIN business_partners bp ON bp.id = d.partner_id
          WHERE d.deleted_at IS NULL AND d.date <= ${day}
            AND (d.status = 'POSTED' OR (d.status = 'VOID' AND d.voided_on > ${day}))
        ) doc
        WHERE doc.total > doc.paid_as_of
      ),
      totals AS (
        SELECT COUNT(*) AS doc_count,
               COALESCE(SUM(outstanding) FILTER (WHERE bucket = 'Current'), 0) AS t_current,
               COALESCE(SUM(outstanding) FILTER (WHERE bucket = '1-30'), 0) AS t_1_30,
               COALESCE(SUM(outstanding) FILTER (WHERE bucket = '31-60'), 0) AS t_31_60,
               COALESCE(SUM(outstanding) FILTER (WHERE bucket = '61-90'), 0) AS t_61_90,
               COALESCE(SUM(outstanding) FILTER (WHERE bucket = '>90'), 0) AS t_over_90,
               COALESCE(SUM(outstanding), 0) AS t_all
        FROM open_docs
      ),
      ranked AS (
        SELECT o.*, COUNT(*) OVER (ORDER BY o.partner_name, o.partner_id) AS through_partner
        FROM open_docs o WHERE ${after}
      )
      SELECT r.id, r.ref, r.partner_id, r.partner_name, r.date, r.due_date,
             r.total, r.paid_as_of, r.outstanding, r.bucket, t.*,
             (SELECT COUNT(*) FROM ranked) AS page_doc_count
      FROM totals t
      LEFT JOIN ranked r ON r.through_partner <= ${maxDocs}
      ORDER BY r.partner_name ASC, r.partner_id ASC, r.date ASC, r.id ASC`);
    const t = rows[0]; // the totals row always exists
    const docs = rows.filter((r) => r.id !== null);
    // ponytail: a single partner with more than maxDocs open documents can
    // never be listed (cut at partner boundaries) — raise the cap if it occurs.
    const truncated = docs.length < Number(t.page_doc_count);

    const byPartner = new Map<
      string,
      {
        partnerId: string;
        partnerName: string;
        rows: {
          ref: string | null;
          date: string;
          dueDate: string | null;
          total: string;
          paidAsOf: string;
          outstanding: string;
          bucket: string;
        }[];
        buckets: Record<string, Money>;
      }
    >();

    for (const r of docs) {
      // Non-null for every real document row (r.id !== null above).
      const outstanding = Money.of(r.outstanding!.toString());
      const bucket = r.bucket!;
      const g = byPartner.get(r.partner_id!) ?? {
        partnerId: r.partner_id!,
        partnerName: r.partner_name!,
        rows: [],
        buckets: Object.fromEntries(BUCKETS.map((b) => [b, Money.zero()])),
      };
      g.rows.push({
        ref: r.ref,
        date: r.date!.toISOString().slice(0, 10),
        dueDate: r.due_date ? r.due_date.toISOString().slice(0, 10) : null,
        total: Money.of(r.total!.toString()).toPersistence(),
        paidAsOf: Money.of(r.paid_as_of!.toString()).toPersistence(),
        outstanding: outstanding.toPersistence(),
        bucket,
      });
      g.buckets[bucket] = g.buckets[bucket].add(outstanding);
      byPartner.set(r.partner_id!, g);
    }
    const money = (d: Prisma.Decimal) => Money.of(d.toString()).toPersistence();

    return {
      kind,
      asOf: asOf.toISOString().slice(0, 10),
      truncated,
      nextAfterPartnerId:
        truncated && docs.length > 0 ? docs[docs.length - 1].partner_id : null,
      partners: [...byPartner.values()].map((g) => ({
        partnerId: g.partnerId,
        partnerName: g.partnerName,
        documents: g.rows,
        buckets: Object.fromEntries(
          BUCKETS.map((b) => [b, g.buckets[b].toPersistence()]),
        ),
      })),
      totalsByBucket: {
        Current: money(t.t_current),
        '1-30': money(t.t_1_30),
        '31-60': money(t.t_31_60),
        '61-90': money(t.t_61_90),
        '>90': money(t.t_over_90),
      },
      totalOutstanding: money(t.t_all),
      documentCount: Number(t.doc_count),
    };
  }
}
