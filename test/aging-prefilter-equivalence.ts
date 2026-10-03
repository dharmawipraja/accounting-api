import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AGING_MAX_DOCS, AgingService } from '../src/reporting/aging.service';

/** Asserts the aging pre-filter is a pure optimisation: for every date on
 *  which any document / payment / application / note event happens (±1 day)
 *  plus today, AR and AP aging with and without it are identical. Call at the
 *  end of a spec that has built a mixed settlement history. */
export async function expectAgingPrefilterEquivalent(
  app: INestApplication,
): Promise<void> {
  const prisma = app.get(PrismaService);
  const rows = await prisma.$queryRaw<{ d: Date }[]>`
    SELECT DISTINCT x::date AS d FROM (
      SELECT date AS x FROM sales_invoices UNION ALL SELECT voided_on FROM sales_invoices
      UNION ALL SELECT date FROM purchase_bills UNION ALL SELECT voided_on FROM purchase_bills
      UNION ALL SELECT date FROM payments UNION ALL SELECT voided_on FROM payments
      UNION ALL SELECT date FROM payment_applications UNION ALL SELECT reversed_on FROM payment_applications
      UNION ALL SELECT date FROM sales_credit_notes UNION ALL SELECT voided_on FROM sales_credit_notes
      UNION ALL SELECT date FROM purchase_debit_notes UNION ALL SELECT voided_on FROM purchase_debit_notes
    ) s WHERE x IS NOT NULL`;
  const DAY = 86_400_000;
  const days = new Set<number>([Date.UTC(2100, 0, 1)]);
  for (const { d } of rows)
    for (const off of [-DAY, 0, DAY]) days.add(d.getTime() + off);
  const aging = app.get(AgingService);
  for (const kind of ['AR', 'AP'] as const)
    for (const t of days) {
      const asOf = new Date(t);
      const fast = await aging.aging(kind, asOf, undefined, AGING_MAX_DOCS);
      const exact = await aging.aging(
        kind,
        asOf,
        undefined,
        AGING_MAX_DOCS,
        false,
      );
      expect({ kind, asOf, report: fast }).toEqual({
        kind,
        asOf,
        report: exact,
      });
    }
  expect(rows.length).toBeGreaterThan(0);
}
