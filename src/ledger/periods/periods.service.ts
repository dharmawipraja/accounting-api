import { Injectable, OnModuleInit } from '@nestjs/common';
import { AccountingPeriod } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CompanyService } from '../../company/company.service';
import {
  ConflictDomainError,
  NotFoundDomainError,
} from '../../common/errors/domain-errors';
import { truncateToUtcDay } from '../../common/dates/utc-day';
import { asOfOrToday } from '../../common/dates/query-dates';
import { idempotencyContext } from '../../common/idempotency/idempotency-context';
import {
  insertFiscalYearPeriodsInTx,
  lockPeriodGeneration,
} from './period-generation';

@Injectable()
export class PeriodsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly company: CompanyService,
  ) {}

  /** On boot, ensure the current AND next fiscal year's periods exist so a
   *  fresh deploy can accept postings immediately and a year rollover never
   *  finds the new year missing (idempotent). "Current" is judged on the
   *  company's calendar day (WIB via REPORT_UTC_OFFSET_MINUTES), not UTC. */
  async onModuleInit(): Promise<void> {
    const fiscalYear = await this.currentFiscalYear();
    await this.generatePeriods(fiscalYear);
    await this.generatePeriods(fiscalYear + 1);
  }

  /** The fiscal year containing today's company (WIB) calendar day. */
  private currentFiscalYear(): Promise<number> {
    return this.company.fiscalYearFor(asOfOrToday());
  }

  /** Idempotent: generates the 12 monthly periods for a fiscal year if absent.
   *  Runs in its own short transaction under the period-generation advisory
   *  lock (serialized with a fiscalYearStartMonth change, which regenerates
   *  periods) and reads the start month under that lock. Deliberately run
   *  OUTSIDE any request idempotency context: auto-generation happens during a
   *  post, and this metadata tx must not mark the request's key committed.
   *  ⚠️ Never call with journal-entry writes pending in the caller's
   *  transaction: this runs on a SEPARATE pool connection, and a
   *  fiscalYearStartMonth change holding the generation lock waits on a
   *  journal_entries table lock the caller's open tx holds — a cross-connection
   *  wait Postgres cannot detect as a deadlock (it only times out). */
  async generatePeriods(fiscalYear: number): Promise<AccountingPeriod[]> {
    const existing = await this.list(fiscalYear);
    if (existing.length === 12) return existing;
    await idempotencyContext.exit(() =>
      this.prisma.transaction(async (tx) => {
        await lockPeriodGeneration(tx);
        const settings = await tx.companySettings.findFirst({
          select: { fiscalYearStartMonth: true },
        });
        if (!settings)
          throw new NotFoundDomainError('Company settings not initialized');
        await insertFiscalYearPeriodsInTx(
          tx,
          fiscalYear,
          settings.fiscalYearStartMonth,
        );
      }),
    );
    return this.list(fiscalYear);
  }

  async list(fiscalYear: number): Promise<AccountingPeriod[]> {
    return this.prisma.client.accountingPeriod.findMany({
      where: { fiscalYear },
      orderBy: { sequence: 'asc' },
    });
  }

  /** The PostingService guard: the OPEN period containing the date, or null. */
  async findOpenPeriodForDate(date: Date): Promise<AccountingPeriod | null> {
    // Truncate to UTC midnight so a date carrying a time-of-day still matches the
    // @db.Date bounds (startDate/endDate are stored at 00:00:00).
    const d = truncateToUtcDay(date);
    return this.prisma.client.accountingPeriod.findFirst({
      where: {
        status: 'OPEN',
        startDate: { lte: d },
        endDate: { gte: d },
      },
    });
  }

  /** The posting-path resolver: the OPEN period containing the date, first
   *  auto-generating that date's fiscal year when NO period (open or closed)
   *  covers it and the year is the CURRENT (WIB) or the NEXT fiscal year —
   *  never an earlier year (backdating needs an explicit POST
   *  /ledger/periods/generate). Shared by preparePosting/assertPostableDate
   *  (and so the journal preview), prepareReversal and postDraft. Generation is idempotent and
   *  concurrency-safe (createMany skipDuplicates → ON CONFLICT DO NOTHING on
   *  the (fiscal_year, sequence) / name uniques). A date further out, or one
   *  inside an existing CLOSED period, still resolves to null (→ 409). */
  async resolveOpenPeriodForDate(date: Date): Promise<AccountingPeriod | null> {
    const open = await this.findOpenPeriodForDate(date);
    if (open) return open;
    const d = truncateToUtcDay(date);
    const covering = await this.prisma.client.accountingPeriod.findFirst({
      where: { startDate: { lte: d }, endDate: { gte: d } },
      select: { id: true },
    });
    if (covering) return null; // exists but CLOSED
    const fiscalYear = await this.company.fiscalYearFor(d);
    const current = await this.currentFiscalYear();
    if (fiscalYear < current || fiscalYear > current + 1) return null;
    await this.generatePeriods(fiscalYear);
    return this.findOpenPeriodForDate(d);
  }

  async close(id: string, closedBy: string): Promise<AccountingPeriod> {
    return this.prisma.transaction(async (tx) => {
      // FOR UPDATE the period row so a concurrent posting (which takes FOR SHARE
      // + re-checks OPEN) serializes; re-check status under the lock.
      const rows = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM accounting_periods WHERE id = ${id} FOR UPDATE`;
      if (rows.length === 0)
        throw new NotFoundDomainError('Period not found', { id });
      if (rows[0].status === 'CLOSED')
        throw new ConflictDomainError('Period already closed', { id });
      return tx.accountingPeriod.update({
        where: { id },
        data: { status: 'CLOSED', closedAt: new Date(), closedBy },
      });
    });
  }

  async reopen(id: string): Promise<AccountingPeriod> {
    const period = await this.prisma.client.accountingPeriod.findUnique({
      where: { id },
    });
    if (!period) throw new NotFoundDomainError('Period not found', { id });
    if (period.status === 'OPEN')
      throw new ConflictDomainError('Period is not closed', { id });
    return this.prisma.client.accountingPeriod.update({
      where: { id },
      data: { status: 'OPEN', closedAt: null, closedBy: null },
    });
  }
}
