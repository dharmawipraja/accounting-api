import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PrismaService,
  REPORT_SNAPSHOT_TX,
} from '../../common/prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { truncateToUtcDay } from '../../common/dates/utc-day';
import { Money } from '../../common/money/money';
import { signedNet } from './signing';
import {
  EXCLUDE_OPENING_JE,
  POSTED_JE,
  excludeClosingJe,
} from './posted-entry.sql';
import type { LedgerTx } from '../../common/prisma/prisma.service';

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
  role: string | null;
  debit: string; // raw summed debits, 4dp
  credit: string; // raw summed credits, 4dp
  balance: string; // normalBalance-signed net, 4dp (convenience)
}

/** Report-view filters for `balancesAsOf` / `movementsBetween`. The defaults
 *  (all false) count every posted entry — the post-closing ledger view. */
export interface BalanceQueryOpts {
  /** Exclude CLOSING entries and REVERSAL entries whose reversal_of_id is a CLOSING entry.
   *  Takes precedence over `excludeClosingFrom` when both are set. */
  excludeClosing?: boolean;
  /** Only exclude closing entries dated >= this day (balance-sheet pre-closing view). */
  excludeClosingFrom?: Date;
  /** Exclude OPENING entries (cash-flow). */
  excludeOpening?: boolean;
  /** Run on this transaction client instead of the base client. */
  tx?: LedgerTx;
}

interface RawBalanceRow {
  account_id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  normal_balance: string;
  cash_flow_category: string;
  role: string | null;
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
   * Run a multi-query report on ONE consistent snapshot: a READ ONLY,
   * REPEATABLE READ transaction whose client every query must receive (pass it
   * as `opts.tx`). Without it each query reads on its own pooled connection
   * under READ COMMITTED, and a post committing mid-request can make the report
   * internally inconsistent (cash flow not reconciling, GL opening + lines ≠
   * closing). Reports are GETs — never under an idempotency context — and the
   * read-only transaction never marks a key anyway.
   */
  snapshot<T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T> {
    return this.prisma.transaction(fn, REPORT_SNAPSHOT_TX);
  }

  /** Grouped per-account debit/credit sums + metadata over a date predicate.
   *  Uses POSTED_JE (the shared posted/not-soft-deleted entry predicate) plus the
   *  accounts-join soft-delete guard. */
  private async groupedBalances(
    dateFilter: Prisma.Sql,
    opts: BalanceQueryOpts = {},
  ): Promise<RawBalanceRow[]> {
    const client = opts.tx ?? this.prisma;
    return client.$queryRaw<RawBalanceRow[]>(Prisma.sql`
      SELECT a.id AS account_id, a.code, a.name, a.type, a.subtype,
             a.normal_balance, a.cash_flow_category, a.role,
             COALESCE(SUM(jl.debit), 0) AS debit,
             COALESCE(SUM(jl.credit), 0) AS credit
      FROM accounts a
      JOIN journal_lines jl ON jl.account_id = a.id
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE ${POSTED_JE} AND a.deleted_at IS NULL AND ${dateFilter}
        AND ${this.entryFilter(opts)}
      GROUP BY a.id, a.code, a.name, a.type, a.subtype, a.normal_balance, a.cash_flow_category, a.role
      ORDER BY a.code ASC`);
  }

  /** SQL for the opts' entry exclusions (`TRUE` when none). */
  private entryFilter(opts: BalanceQueryOpts): Prisma.Sql {
    const parts: Prisma.Sql[] = [];
    if (opts.excludeClosing) parts.push(excludeClosingJe());
    else if (opts.excludeClosingFrom)
      parts.push(excludeClosingJe(truncateToUtcDay(opts.excludeClosingFrom)));
    if (opts.excludeOpening) parts.push(EXCLUDE_OPENING_JE);
    return parts.length ? Prisma.join(parts, ' AND ') : Prisma.sql`TRUE`;
  }

  private toRow(r: RawBalanceRow): AccountBalanceRow {
    const net = signedNet(
      r.normal_balance,
      Money.of(r.debit.toString()),
      Money.of(r.credit.toString()),
    );
    return {
      accountId: r.account_id,
      code: r.code,
      name: r.name,
      type: r.type,
      subtype: r.subtype,
      normalBalance: r.normal_balance,
      cashFlowCategory: r.cash_flow_category,
      role: r.role,
      debit: Money.of(r.debit.toString()).toPersistence(),
      credit: Money.of(r.credit.toString()).toPersistence(),
      balance: net.toPersistence(),
    };
  }

  /** Every account's cumulative debit/credit + metadata as of a date. */
  async balancesAsOf(
    asOf: Date,
    opts?: BalanceQueryOpts,
  ): Promise<AccountBalanceRow[]> {
    const day = truncateToUtcDay(asOf);
    const rows = await this.groupedBalances(
      Prisma.sql`je.date <= ${day}`,
      opts,
    );
    return rows.map((r) => this.toRow(r));
  }

  /** Every account's debit/credit movement over [from, to] (inclusive). */
  async movementsBetween(
    from: Date,
    to: Date,
    opts?: BalanceQueryOpts,
  ): Promise<AccountBalanceRow[]> {
    const f = truncateToUtcDay(from);
    const t = truncateToUtcDay(to);
    const rows = await this.groupedBalances(
      Prisma.sql`je.date >= ${f} AND je.date <= ${t}`,
      opts,
    );
    return rows.map((r) => this.toRow(r));
  }

  /** `preClosing`: leave out a CLOSING entry (and its reopen reversal) dated
   *  ON asOf — the fiscal year-end — so P&L accounts show their pre-close
   *  balances, matching the Neraca's pre-closing view. Earlier years' closings
   *  still count. Default: every posted entry (post-closing ledger view). */
  async trialBalance(
    asOf: Date,
    opts: { preClosing?: boolean } = {},
  ): Promise<TrialBalance> {
    const day = truncateToUtcDay(asOf);
    const rows = await this.groupedBalances(
      Prisma.sql`je.date <= ${day}`,
      opts.preClosing ? { excludeClosingFrom: asOf } : {},
    );
    // Sum via Money (40-digit precision): Prisma.Decimal's default 20
    // significant digits would round a trial-balance total past 16 integer
    // digits + 4dp.
    let totalDebit = Money.zero();
    let totalCredit = Money.zero();
    const out: TrialBalanceRow[] = [];
    for (const r of rows) {
      if (r.debit.isZero() && r.credit.isZero()) continue; // preserve old HAVING
      const debit = Money.of(r.debit.toString());
      const credit = Money.of(r.credit.toString());
      totalDebit = totalDebit.add(debit);
      totalCredit = totalCredit.add(credit);
      const net = signedNet(r.normal_balance, debit, credit);
      out.push({
        accountId: r.account_id,
        code: r.code,
        name: r.name,
        debit: debit.toPersistence(),
        credit: credit.toPersistence(),
        balance: net.toPersistence(),
      });
    }
    return {
      asOf: asOf.toISOString().slice(0, 10),
      rows: out,
      totalDebit: totalDebit.toPersistence(),
      totalCredit: totalCredit.toPersistence(),
    };
  }

  async accountBalance(
    accountId: string,
    asOf: Date,
    opts: Pick<BalanceQueryOpts, 'tx'> = {},
  ): Promise<{
    accountId: string;
    debit: string;
    credit: string;
    balance: string;
  }> {
    const account = await this.accounts.findById(accountId, opts.tx);
    const day = truncateToUtcDay(asOf);
    const client = opts.tx ?? this.prisma;
    const rows = await client.$queryRaw<
      { debit: Prisma.Decimal; credit: Prisma.Decimal }[]
    >`
      SELECT COALESCE(SUM(jl.debit), 0) AS debit, COALESCE(SUM(jl.credit), 0) AS credit
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.account_id = ${accountId} AND ${POSTED_JE} AND je.date <= ${day}`;
    const debit = rows[0].debit;
    const credit = rows[0].credit;
    const net = signedNet(
      account.normalBalance,
      Money.of(debit.toString()),
      Money.of(credit.toString()),
    );
    return {
      accountId,
      debit: Money.of(debit.toString()).toPersistence(),
      credit: Money.of(credit.toString()).toPersistence(),
      balance: net.toPersistence(),
    };
  }
}
