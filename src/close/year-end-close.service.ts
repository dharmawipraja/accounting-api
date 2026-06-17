import { Injectable } from '@nestjs/common';
import { YearEndClosing } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import { PostingService } from '../ledger/posting/posting.service';
import { BalancesService } from '../ledger/balances/balances.service';
import { CompanyService } from '../company/company.service';
import { PostLineInput } from '../ledger/posting/posting.types';
import {
  ConflictDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';

const RETAINED_EARNINGS_CODE = '3-2000';

@Injectable()
export class YearEndCloseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
    private readonly balances: BalancesService,
    private readonly company: CompanyService,
  ) {}

  /** First UTC day of the fiscal year, given the company's start month. */
  private fiscalYearStart(fiscalYear: number, startMonth: number): Date {
    return new Date(Date.UTC(fiscalYear, startMonth - 1, 1));
  }

  /** Last UTC day of the fiscal year, given the company's start month. */
  private fiscalYearEnd(fiscalYear: number, startMonth: number): Date {
    const endYear = startMonth === 1 ? fiscalYear : fiscalYear + 1;
    const endMonth0 = startMonth === 1 ? 11 : startMonth - 2; // 0-based last month
    return new Date(Date.UTC(endYear, endMonth0 + 1, 0)); // day 0 of next month = last day
  }

  async getStatus(fiscalYear: number): Promise<YearEndClosing | null> {
    return this.prisma.client.yearEndClosing.findUnique({
      where: { fiscalYear },
    });
  }

  async close(fiscalYear: number, closedBy: string): Promise<YearEndClosing> {
    const existing = await this.getStatus(fiscalYear);
    if (existing?.status === 'CLOSED') {
      throw new ConflictDomainError('Fiscal year is already closed', {
        fiscalYear,
      });
    }
    const settings = await this.company.get();
    const yearEnd = this.fiscalYearEnd(
      fiscalYear,
      settings.fiscalYearStartMonth,
    );
    const fyStart = this.fiscalYearStart(
      fiscalYear,
      settings.fiscalYearStartMonth,
    );

    // Net income from THIS year's P&L movement only — not the cumulative
    // balance. Using movementsBetween makes close order-independent: closing a
    // later year before an earlier one no longer sweeps the earlier year's
    // earnings twice into Laba Ditahan. (For in-order closes the two are equal,
    // since each prior close already zeroed that year's P&L.)
    const rows = (
      await this.balances.movementsBetween(fyStart, yearEnd)
    ).filter((r) => r.type === 'REVENUE' || r.type === 'EXPENSE');
    const lines: PostLineInput[] = [];
    let netIncome = Money.zero(); // Σ(credit − debit)
    for (const r of rows) {
      const position = Money.of(r.debit).subtract(Money.of(r.credit)); // debit − credit
      if (position.isZero()) continue;
      netIncome = netIncome.subtract(position);
      lines.push(
        position.isNegative()
          ? {
              accountId: r.accountId,
              debit: position.multiply('-1').toPersistence(),
            }
          : { accountId: r.accountId, credit: position.toPersistence() },
      );
    }

    // Empty year: no P&L movement — mark closed without an entry.
    if (lines.length === 0) {
      return this.upsertClosed(fiscalYear, null, '0.0000', closedBy);
    }

    if (!netIncome.isZero()) {
      const retained = await this.prisma.client.account.findFirst({
        where: { code: RETAINED_EARNINGS_CODE },
      });
      if (!retained) {
        throw new ValidationFailedError(
          'Laba Ditahan account missing from chart',
          {
            code: RETAINED_EARNINGS_CODE,
          },
        );
      }
      lines.push(
        netIncome.isNegative()
          ? {
              accountId: retained.id,
              debit: netIncome.multiply('-1').toPersistence(),
            }
          : { accountId: retained.id, credit: netIncome.toPersistence() },
      );
    }

    const closingInput = {
      date: yearEnd,
      description: `Year-end close FY${fiscalYear}`,
      sourceType: 'CLOSING' as const,
      createdBy: closedBy,
      lines,
    };
    const { periodId, fiscalYear: fy } = await this.posting.preparePosting(
      closingInput,
      closedBy,
    );
    const incomeStr = netIncome.toPersistence();
    await this.prisma.client.$transaction(async (tx) => {
      // Serialize concurrent year-end closes for this fiscal year, then re-check
      // status under the lock — so a double-close can't post (and orphan) a
      // second closing entry. The advisory lock auto-releases at tx end and
      // works whether or not the year_end_closings row exists yet.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${fiscalYear})`;
      const current = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM year_end_closings WHERE fiscal_year = ${fiscalYear}`;
      if (current.length > 0 && current[0].status === 'CLOSED') {
        throw new ConflictDomainError('Fiscal year is already closed', {
          fiscalYear,
        });
      }
      const entry = await this.posting.createPostedEntryInTx(
        tx,
        closingInput,
        closedBy,
        periodId,
        fy,
      );
      await tx.yearEndClosing.upsert({
        where: { fiscalYear },
        create: {
          fiscalYear,
          status: 'CLOSED',
          closingEntryId: entry.id,
          netIncome: incomeStr,
          closedAt: new Date(),
          closedBy,
        },
        update: {
          status: 'CLOSED',
          closingEntryId: entry.id,
          netIncome: incomeStr,
          closedAt: new Date(),
          closedBy,
          reopenedAt: null,
          reopenedBy: null,
        },
      });
    });
    return this.getStatus(fiscalYear) as Promise<YearEndClosing>;
  }

  private async upsertClosed(
    fiscalYear: number,
    closingEntryId: string | null,
    netIncome: string,
    closedBy: string,
  ): Promise<YearEndClosing> {
    return this.prisma.client.yearEndClosing.upsert({
      where: { fiscalYear },
      create: {
        fiscalYear,
        status: 'CLOSED',
        closingEntryId,
        netIncome,
        closedAt: new Date(),
        closedBy,
      },
      update: {
        status: 'CLOSED',
        closingEntryId,
        netIncome,
        closedAt: new Date(),
        closedBy,
        reopenedAt: null,
        reopenedBy: null,
      },
    });
  }

  async reopen(
    fiscalYear: number,
    reopenedBy: string,
  ): Promise<YearEndClosing> {
    const rec = await this.getStatus(fiscalYear);
    if (!rec || rec.status !== 'CLOSED') {
      throw new ValidationFailedError('Fiscal year is not closed', {
        fiscalYear,
      });
    }
    if (rec.closingEntryId) {
      const {
        original,
        periodId,
        fiscalYear: fy,
        reversalDate,
      } = await this.posting.prepareReversal(rec.closingEntryId, undefined, {
        allowClosedYear: true,
      });
      await this.prisma.client.$transaction(async (tx) => {
        // Serialize concurrent reopens of this fiscal year (mirror close's
        // advisory lock), then re-check status under the lock so a double-reopen
        // can't double-reverse the closing entry.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${fiscalYear})`;
        const current = await tx.$queryRaw<{ status: string }[]>`
          SELECT status FROM year_end_closings WHERE fiscal_year = ${fiscalYear}`;
        if (current.length === 0 || current[0].status !== 'CLOSED') {
          throw new ValidationFailedError('Fiscal year is not closed', {
            fiscalYear,
          });
        }
        await this.posting.reverseInTx(
          tx,
          original,
          reopenedBy,
          periodId,
          fy,
          reversalDate,
        );
        await tx.yearEndClosing.update({
          where: { fiscalYear },
          data: { status: 'OPEN', reopenedAt: new Date(), reopenedBy },
        });
      });
    } else {
      await this.prisma.client.yearEndClosing.update({
        where: { fiscalYear },
        data: { status: 'OPEN', reopenedAt: new Date(), reopenedBy },
      });
    }
    return this.getStatus(fiscalYear) as Promise<YearEndClosing>;
  }
}
