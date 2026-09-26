import { Injectable, OnModuleInit } from '@nestjs/common';
import { CompanySettings, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';
import {
  fiscalYearForDate,
  fiscalYearStartDate,
  fiscalYearEndDate,
} from '../common/dates/fiscal-year';
import { asOfOrToday } from '../common/dates/query-dates';
import {
  insertFiscalYearPeriodsInTx,
  lockPeriodGeneration,
} from '../ledger/periods/period-generation';

export interface UpdateCompanyInput {
  legalName?: string;
  npwp?: string | null;
  address?: string | null;
  fiscalYearStartMonth?: number;
  segregationOfDutiesEnabled?: boolean;
  isPkp?: boolean;
}

@Injectable()
export class CompanyService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.seedIfEmpty();
  }

  /** Idempotent and race-safe: creates the single settings row only if none exists. */
  async seedIfEmpty(): Promise<void> {
    const existing = await this.prisma.client.companySettings.findFirst();
    if (existing) return;
    try {
      await this.prisma.client.companySettings.create({
        data: { legalName: 'My Company' },
      });
    } catch (err) {
      // Another instance won the boot race; the singleton row now exists.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return;
      }
      throw err;
    }
  }

  async get(): Promise<CompanySettings> {
    const settings = await this.prisma.client.companySettings.findFirst();
    if (!settings) {
      throw new NotFoundDomainError('Company settings not initialized');
    }
    return settings;
  }

  /** The fiscal year a date falls into, per the configured start month. */
  async fiscalYearFor(date: Date): Promise<number> {
    const { fiscalYearStartMonth } = await this.get();
    return fiscalYearForDate(date, fiscalYearStartMonth);
  }

  /** UTC [start, end] date bounds of a fiscal year. */
  async fiscalYearBounds(
    fiscalYear: number,
  ): Promise<{ start: Date; end: Date }> {
    const { fiscalYearStartMonth } = await this.get();
    return {
      start: fiscalYearStartDate(fiscalYear, fiscalYearStartMonth),
      end: fiscalYearEndDate(fiscalYear, fiscalYearStartMonth),
    };
  }

  /** Whether a post violates segregation of duties (enabled + MANUAL + poster is the creator). */
  async isSegregationViolation(args: {
    sourceType: string;
    createdBy: string;
    postedBy: string;
  }): Promise<boolean> {
    const { segregationOfDutiesEnabled } = await this.get();
    return (
      segregationOfDutiesEnabled &&
      args.sourceType === 'MANUAL' &&
      args.postedBy === args.createdBy
    );
  }

  /** Update the settings. A fiscalYearStartMonth change re-slices every fiscal
   *  year, so it is only allowed while nothing depends on the current slicing:
   *  no journal entry (any status, soft-deleted included), no CLOSED period and
   *  no year_end_closings row → else 422. When allowed, in the same tx (under
   *  the period-generation lock, serialized with PeriodsService.generatePeriods)
   *  the OPEN periods — unreferenced, as only journal_entries.period_id points at
   *  periods — are deleted and the current + next fiscal year (WIB today, new
   *  start month) are regenerated.
   *
   *  Whenever `fiscalYearStartMonth` is PRESENT — even equal to the pre-lock
   *  read — the write takes the locked path and compares against the row
   *  RE-READ under the lock: an unlocked same-value write from a stale read
   *  could otherwise silently revert a concurrent, committed change (leaving
   *  periods sliced for the other month). Only an input without the field is
   *  written unlocked. */
  async update(input: UpdateCompanyInput): Promise<CompanySettings> {
    const current = await this.get();
    const newMonth = input.fiscalYearStartMonth;
    if (newMonth === undefined) {
      return this.prisma.client.companySettings.update({
        where: { id: current.id },
        data: input,
      });
    }
    return this.prisma.transaction(async (tx) => {
      await lockPeriodGeneration(tx);
      // Freeze the checked tables until commit: SHARE ROW EXCLUSIVE blocks
      // concurrent INSERT/UPDATE/DELETE (a new draft JE, a period close, a
      // year close) but not reads, so the checks below stay true while the
      // periods are replaced. A rare admin action — the brief stall is fine.
      // Bounded wait: behind a long-running writer, give up after 5s (55P03 →
      // 409 retryable) instead of queueing — a queued SHARE ROW EXCLUSIVE
      // request would itself block every new write until it got the lock.
      await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
      await tx.$executeRaw`
        LOCK TABLE journal_entries, accounting_periods, year_end_closings
        IN SHARE ROW EXCLUSIVE MODE`;
      // Re-read under the lock: every start-month writer holds it, so this
      // sees the latest committed month.
      const locked = await tx.companySettings.findUniqueOrThrow({
        where: { id: current.id },
      });
      if (newMonth === locked.fiscalYearStartMonth) {
        return tx.companySettings.update({
          where: { id: current.id },
          data: input,
        });
      }
      const [blockers] = await tx.$queryRaw<
        { journal: boolean; closed_period: boolean; closing: boolean }[]
      >`
        SELECT EXISTS (SELECT 1 FROM journal_entries) AS journal,
               EXISTS (SELECT 1 FROM accounting_periods WHERE status = 'CLOSED') AS closed_period,
               EXISTS (SELECT 1 FROM year_end_closings) AS closing`;
      if (blockers.journal || blockers.closed_period || blockers.closing)
        throw new ValidationFailedError(
          'fiscalYearStartMonth cannot change once a journal entry, a closed period or a year-end close exists',
          {
            fiscalYearStartMonth: locked.fiscalYearStartMonth,
            requested: newMonth,
            journalEntriesExist: blockers.journal,
            closedPeriodsExist: blockers.closed_period,
            yearEndClosingsExist: blockers.closing,
          },
        );
      const updated = await tx.companySettings.update({
        where: { id: current.id },
        data: input,
      });
      await tx.accountingPeriod.deleteMany({ where: { status: 'OPEN' } });
      const fy = fiscalYearForDate(asOfOrToday(), newMonth);
      await insertFiscalYearPeriodsInTx(tx, fy, newMonth);
      await insertFiscalYearPeriodsInTx(tx, fy + 1, newMonth);
      return updated;
    });
  }
}
