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

@Injectable()
export class YearEndCloseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
    private readonly balances: BalancesService,
    private readonly company: CompanyService,
  ) {}

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
    const { start: fyStart, end: yearEnd } =
      await this.company.fiscalYearBounds(fiscalYear);

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
        where: { role: 'RETAINED_EARNINGS' },
      });
      if (!retained) {
        throw new ValidationFailedError(
          'Laba Ditahan account missing from chart',
          { role: 'RETAINED_EARNINGS' },
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
    const prepared = await this.posting.preparePosting(closingInput, closedBy);
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
      const entry = await this.posting.createPostedEntryInTx(tx, prepared);
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
      const prepared = await this.posting.prepareReversal(
        rec.closingEntryId,
        reopenedBy,
        undefined,
        { allowClosedYear: true },
      );
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
        await this.posting.reverseInTx(tx, prepared);
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
