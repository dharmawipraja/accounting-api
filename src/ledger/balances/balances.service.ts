import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { truncateToUtcDay } from '../../common/dates/utc-day';

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

export interface AccountBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  normalBalance: string;
  cashFlowCategory: string;
  parentId: string | null;
  debit: string; // raw summed debits, 4dp
  credit: string; // raw summed credits, 4dp
  balance: string; // normalBalance-signed net, 4dp (convenience)
}

interface RawBalanceRow {
  account_id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  normal_balance: string;
  cash_flow_category: string;
  parent_id: string | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
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
    return truncateToUtcDay(d);
  }

  /** Grouped per-account debit/credit sums + metadata over a date predicate.
   *  Single source of the posted_at/soft-delete rules (shared with trialBalance). */
  private async groupedBalances(
    dateFilter: Prisma.Sql,
  ): Promise<RawBalanceRow[]> {
    return this.prisma.$queryRaw<RawBalanceRow[]>(Prisma.sql`
      SELECT a.id AS account_id, a.code, a.name, a.type, a.subtype,
             a.normal_balance, a.cash_flow_category, a.parent_id,
             COALESCE(SUM(jl.debit), 0) AS debit,
             COALESCE(SUM(jl.credit), 0) AS credit
      FROM accounts a
      JOIN journal_lines jl ON jl.account_id = a.id
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.posted_at IS NOT NULL AND je.deleted_at IS NULL AND a.deleted_at IS NULL AND ${dateFilter}
      GROUP BY a.id, a.code, a.name, a.type, a.subtype, a.normal_balance, a.cash_flow_category, a.parent_id
      ORDER BY a.code ASC`);
  }

  private toRow(r: RawBalanceRow): AccountBalanceRow {
    const net =
      r.normal_balance === 'DEBIT'
        ? r.debit.sub(r.credit)
        : r.credit.sub(r.debit);
    return {
      accountId: r.account_id,
      code: r.code,
      name: r.name,
      type: r.type,
      subtype: r.subtype,
      normalBalance: r.normal_balance,
      cashFlowCategory: r.cash_flow_category,
      parentId: r.parent_id,
      debit: r.debit.toFixed(4),
      credit: r.credit.toFixed(4),
      balance: net.toFixed(4),
    };
  }

  /** Every account's cumulative debit/credit + metadata as of a date. */
  async balancesAsOf(asOf: Date): Promise<AccountBalanceRow[]> {
    const day = this.toUtcDay(asOf);
    const rows = await this.groupedBalances(Prisma.sql`je.date <= ${day}`);
    return rows.map((r) => this.toRow(r));
  }

  /** Every account's debit/credit movement over [from, to] (inclusive). */
  async movementsBetween(from: Date, to: Date): Promise<AccountBalanceRow[]> {
    const f = this.toUtcDay(from);
    const t = this.toUtcDay(to);
    const rows = await this.groupedBalances(
      Prisma.sql`je.date >= ${f} AND je.date <= ${t}`,
    );
    return rows.map((r) => this.toRow(r));
  }

  async trialBalance(asOf: Date): Promise<TrialBalance> {
    const day = this.toUtcDay(asOf);
    const rows = await this.groupedBalances(Prisma.sql`je.date <= ${day}`);
    let totalDebit = new Prisma.Decimal(0);
    let totalCredit = new Prisma.Decimal(0);
    const out: TrialBalanceRow[] = [];
    for (const r of rows) {
      if (r.debit.isZero() && r.credit.isZero()) continue; // preserve old HAVING
      totalDebit = totalDebit.add(r.debit);
      totalCredit = totalCredit.add(r.credit);
      const net =
        r.normal_balance === 'DEBIT'
          ? r.debit.sub(r.credit)
          : r.credit.sub(r.debit);
      out.push({
        accountId: r.account_id,
        code: r.code,
        name: r.name,
        debit: r.debit.toFixed(4),
        credit: r.credit.toFixed(4),
        balance: net.toFixed(4),
      });
    }
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
      WHERE jl.account_id = ${accountId} AND je.posted_at IS NOT NULL AND je.deleted_at IS NULL AND je.date <= ${day}`;
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
