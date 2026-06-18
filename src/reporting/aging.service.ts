import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import { truncateToUtcDay } from '../common/dates/utc-day';

interface DocRow {
  id: string;
  ref: string | null;
  partner_id: string;
  partner_name: string;
  date: Date;
  due_date: Date | null;
  total: Prisma.Decimal;
  paid_as_of: Prisma.Decimal;
}

const BUCKETS = ['Current', '1-30', '31-60', '61-90', '>90'] as const;

@Injectable()
export class AgingService {
  constructor(private readonly prisma: PrismaService) {}

  private day(d: Date): Date {
    return truncateToUtcDay(d);
  }

  private bucketOf(daysPastDue: number): string {
    if (daysPastDue <= 0) return 'Current';
    if (daysPastDue <= 30) return '1-30';
    if (daysPastDue <= 60) return '31-60';
    if (daysPastDue <= 90) return '61-90';
    return '>90';
  }

  /** kind: 'AR' (sales_invoices + sales_invoice_id) | 'AP' (purchase_bills + purchase_bill_id) */
  async aging(kind: 'AR' | 'AP', asOf: Date) {
    const day = this.day(asOf);
    const docTable =
      kind === 'AR'
        ? Prisma.raw('sales_invoices')
        : Prisma.raw('purchase_bills');
    const allocCol =
      kind === 'AR'
        ? Prisma.raw('sales_invoice_id')
        : Prisma.raw('purchase_bill_id');
    const refCol =
      kind === 'AR' ? Prisma.raw('d.invoice_ref') : Prisma.raw('d.bill_ref');

    const rows = await this.prisma.$queryRaw<DocRow[]>(Prisma.sql`
      SELECT d.id, ${refCol} AS ref,
             d.partner_id, bp.name AS partner_name, d.date, d.due_date, d.total,
             COALESCE((
               SELECT SUM(pa.amount) FROM payment_allocations pa
               JOIN payments p ON p.id = pa.payment_id
               WHERE pa.${allocCol} = d.id AND p.status = 'POSTED' AND p.deleted_at IS NULL AND p.date <= ${day}
             ), 0) AS paid_as_of
      FROM ${docTable} d
      JOIN business_partners bp ON bp.id = d.partner_id
      WHERE d.status = 'POSTED' AND d.deleted_at IS NULL AND d.date <= ${day}
      ORDER BY bp.name ASC, d.date ASC`);

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
    const grand: Record<string, Money> = Object.fromEntries(
      BUCKETS.map((b) => [b, Money.zero()]),
    );
    let grandTotal = Money.zero();

    for (const r of rows) {
      const outstanding = Money.of(r.total.toString()).subtract(
        Money.of(r.paid_as_of.toString()),
      );
      if (outstanding.isZero() || outstanding.isNegative()) continue;
      const dueOrDate = r.due_date ?? r.date;
      const daysPastDue = Math.floor(
        (day.getTime() - this.day(dueOrDate).getTime()) / 86_400_000,
      );
      const bucket = this.bucketOf(daysPastDue);
      const g = byPartner.get(r.partner_id) ?? {
        partnerId: r.partner_id,
        partnerName: r.partner_name,
        rows: [],
        buckets: Object.fromEntries(BUCKETS.map((b) => [b, Money.zero()])),
      };
      g.rows.push({
        ref: r.ref,
        date: r.date.toISOString().slice(0, 10),
        dueDate: r.due_date ? r.due_date.toISOString().slice(0, 10) : null,
        total: Money.of(r.total.toString()).toPersistence(),
        paidAsOf: Money.of(r.paid_as_of.toString()).toPersistence(),
        outstanding: outstanding.toPersistence(),
        bucket,
      });
      g.buckets[bucket] = g.buckets[bucket].add(outstanding);
      byPartner.set(r.partner_id, g);
      grand[bucket] = grand[bucket].add(outstanding);
      grandTotal = grandTotal.add(outstanding);
    }

    return {
      kind,
      asOf: asOf.toISOString().slice(0, 10),
      partners: [...byPartner.values()].map((g) => ({
        partnerId: g.partnerId,
        partnerName: g.partnerName,
        documents: g.rows,
        buckets: Object.fromEntries(
          BUCKETS.map((b) => [b, g.buckets[b].toPersistence()]),
        ),
      })),
      totalsByBucket: Object.fromEntries(
        BUCKETS.map((b) => [b, grand[b].toPersistence()]),
      ),
      totalOutstanding: grandTotal.toPersistence(),
    };
  }
}
