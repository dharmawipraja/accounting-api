import { Injectable, OnModuleInit } from '@nestjs/common';
import { AccountingPeriod } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CompanyService } from '../../company/company.service';
import {
  ConflictDomainError,
  NotFoundDomainError,
} from '../../common/errors/domain-errors';
import { fiscalYearForDate } from '../../common/dates/fiscal-year';
import { truncateToUtcDay } from '../../common/dates/utc-day';

@Injectable()
export class PeriodsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly company: CompanyService,
  ) {}

  /** On boot, ensure the current fiscal year's periods exist so a fresh deploy
   *  can accept postings immediately (idempotent). */
  async onModuleInit(): Promise<void> {
    const settings = await this.company.get();
    const now = new Date();
    const fiscalYear = fiscalYearForDate(now, settings.fiscalYearStartMonth);
    await this.generatePeriods(fiscalYear);
  }

  /** Idempotent: generates the 12 monthly periods for a fiscal year if absent. */
  async generatePeriods(fiscalYear: number): Promise<AccountingPeriod[]> {
    const existing = await this.list(fiscalYear);
    if (existing.length === 12) return existing;
    const settings = await this.company.get();
    const startMonth = settings.fiscalYearStartMonth; // 1..12
    const data = Array.from({ length: 12 }, (_, i) => {
      const monthIndex = startMonth - 1 + i; // 0-based from Jan of fiscalYear
      const year = fiscalYear + Math.floor(monthIndex / 12);
      const month = monthIndex % 12; // 0..11
      const start = new Date(Date.UTC(year, month, 1));
      const end = new Date(Date.UTC(year, month + 1, 0));
      // name is {fiscalYear}-{sequence}, NOT {calendarYear}-{calendarMonth};
      // for a non-January fiscal start, sequence 1 is the start month.
      const name = `${fiscalYear}-${String(i + 1).padStart(2, '0')}`;
      return {
        fiscalYear,
        sequence: i + 1,
        name,
        startDate: start,
        endDate: end,
      };
    });
    await this.prisma.client.accountingPeriod.createMany({
      data,
      skipDuplicates: true,
    });
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

  async close(id: string, closedBy: string): Promise<AccountingPeriod> {
    const period = await this.prisma.client.accountingPeriod.findUnique({
      where: { id },
    });
    if (!period) throw new NotFoundDomainError('Period not found', { id });
    if (period.status === 'CLOSED')
      throw new ConflictDomainError('Period already closed', { id });
    return this.prisma.client.accountingPeriod.update({
      where: { id },
      data: { status: 'CLOSED', closedAt: new Date(), closedBy },
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
