import { Prisma } from '@prisma/client';
import type { LedgerTx } from '../../common/prisma/prisma.service';
import { fiscalYearStartDate } from '../../common/dates/fiscal-year';

/** Transaction-scoped advisory-lock key serializing every writer of
 *  `accounting_periods` rows by generation: PeriodsService.generatePeriods
 *  (boot, POST /ledger/periods/generate, posting-path auto-generation) and the
 *  fiscalYearStartMonth change in CompanyService.update (which deletes the OPEN
 *  periods and regenerates them for the new start month). Distinct from the
 *  admin-pool key 71_001_001 and from the per-fiscal-year keys (the year number
 *  itself, e.g. 2026, taken by posting/close). */
const PERIOD_GENERATION_LOCK_KEY = 71_002_001;

interface PeriodRow {
  fiscalYear: number;
  sequence: number;
  name: string;
  startDate: Date;
  endDate: Date;
}

/** Pure: the 12 monthly period rows of a fiscal year for a start month (1-12).
 *  `name` is {fiscalYear}-{sequence}, NOT {calendarYear}-{calendarMonth}; for a
 *  non-January start, sequence 1 is the start month. */
function buildFiscalYearPeriods(
  fiscalYear: number,
  startMonth: number,
): PeriodRow[] {
  const first = fiscalYearStartDate(fiscalYear, startMonth);
  return Array.from({ length: 12 }, (_, i) => {
    const y = first.getUTCFullYear();
    const m = first.getUTCMonth() + i; // may exceed 11; Date.UTC rolls over
    return {
      fiscalYear,
      sequence: i + 1,
      name: `${fiscalYear}-${String(i + 1).padStart(2, '0')}`,
      startDate: new Date(Date.UTC(y, m, 1)),
      endDate: new Date(Date.UTC(y, m + 1, 0)),
    };
  });
}

/** Take the period-generation lock (first statement of the caller's tx). */
export async function lockPeriodGeneration(tx: LedgerTx): Promise<void> {
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(${PERIOD_GENERATION_LOCK_KEY})`,
  );
}

/** Insert a fiscal year's periods if absent (idempotent: skipDuplicates →
 *  ON CONFLICT DO NOTHING). Call under lockPeriodGeneration. */
export async function insertFiscalYearPeriodsInTx(
  tx: LedgerTx,
  fiscalYear: number,
  startMonth: number,
): Promise<void> {
  await tx.accountingPeriod.createMany({
    data: buildFiscalYearPeriods(fiscalYear, startMonth),
    skipDuplicates: true,
  });
}
