import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  debit: string;
  credit: string;
  balance: string;
}

export interface TrialBalance {
  asOf: string;
  rows: TrialBalanceRow[];
  totalDebit: string;
  totalCredit: string;
}

@Injectable()
export class BalancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
  ) {}

  /**
   * Truncate to UTC midnight so an as-of date carrying a time-of-day still
   * includes entries dated on that day (`je.date` is a `@db.Date`).
   */
  private toUtcDay(d: Date): Date {
    return new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    );
  }

  async trialBalance(asOf: Date): Promise<TrialBalance> {
    const day = this.toUtcDay(asOf);
    const rows = await this.prisma.$queryRaw<
      {
        account_id: string;
        code: string;
        name: string;
        debit: Prisma.Decimal;
        credit: Prisma.Decimal;
        normal_balance: string;
      }[]
    >`
      SELECT a.id AS account_id, a.code, a.name, a.normal_balance,
             COALESCE(SUM(jl.debit), 0) AS debit,
             COALESCE(SUM(jl.credit), 0) AS credit
      FROM accounts a
      JOIN journal_lines jl ON jl.account_id = a.id
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.posted_at IS NOT NULL AND je.date <= ${day} AND a.deleted_at IS NULL
      GROUP BY a.id, a.code, a.name, a.normal_balance
      HAVING COALESCE(SUM(jl.debit), 0) <> 0 OR COALESCE(SUM(jl.credit), 0) <> 0
      ORDER BY a.code ASC`;

    let totalDebit = new Prisma.Decimal(0);
    let totalCredit = new Prisma.Decimal(0);
    const out: TrialBalanceRow[] = rows.map((r) => {
      totalDebit = totalDebit.add(r.debit);
      totalCredit = totalCredit.add(r.credit);
      const net =
        r.normal_balance === 'DEBIT'
          ? r.debit.sub(r.credit)
          : r.credit.sub(r.debit);
      return {
        accountId: r.account_id,
        code: r.code,
        name: r.name,
        debit: r.debit.toFixed(4),
        credit: r.credit.toFixed(4),
        balance: net.toFixed(4),
      };
    });
    return {
      asOf: asOf.toISOString().slice(0, 10),
      rows: out,
      totalDebit: totalDebit.toFixed(4),
      totalCredit: totalCredit.toFixed(4),
    };
  }

  async accountBalance(
    accountId: string,
    asOf: Date,
  ): Promise<{
    accountId: string;
    debit: string;
    credit: string;
    balance: string;
  }> {
    const account = await this.accounts.findById(accountId);
    const day = this.toUtcDay(asOf);
    const rows = await this.prisma.$queryRaw<
      { debit: Prisma.Decimal; credit: Prisma.Decimal }[]
    >`
      SELECT COALESCE(SUM(jl.debit), 0) AS debit, COALESCE(SUM(jl.credit), 0) AS credit
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.account_id = ${accountId} AND je.posted_at IS NOT NULL AND je.date <= ${day}`;
    const debit = rows[0].debit;
    const credit = rows[0].credit;
    const net =
      account.normalBalance === 'DEBIT' ? debit.sub(credit) : credit.sub(debit);
    return {
      accountId,
      debit: debit.toFixed(4),
      credit: credit.toFixed(4),
      balance: net.toFixed(4),
    };
  }
}
