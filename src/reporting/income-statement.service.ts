import { Injectable } from '@nestjs/common';
import { Money } from '../common/money/money';
import type { LedgerTx } from '../common/prisma/prisma.service';
import {
  BalancesService,
  AccountBalanceRow,
} from '../ledger/balances/balances.service';
import { naturalSide } from '../ledger/balances/signing';
import {
  ReportLine,
  VarianceLine,
  moneyVariance,
  varianceLines,
} from './report-line';

const TOTAL_KEYS = [
  'revenue',
  'cogs',
  'grossProfit',
  'operatingExpense',
  'operatingProfit',
  'otherIncome',
  'otherExpense',
  'profitBeforeTax',
  'taxExpense',
  'netIncome',
] as const;
const LINE_KEYS = [
  'revenueLines',
  'cogsLines',
  'operatingExpenseLines',
  'otherIncomeLines',
  'otherExpenseLines',
  'taxExpenseLines',
] as const;

type IncomeStatement = { from: string; to: string } & Record<
  (typeof TOTAL_KEYS)[number],
  string
> &
  Record<(typeof LINE_KEYS)[number], ReportLine[]>;

type IncomeStatementVariance = Record<(typeof TOTAL_KEYS)[number], string> &
  Record<(typeof LINE_KEYS)[number], VarianceLine[]>;

/** current − comparative for every total, and per account for every section. */
function incomeStatementVariance(
  cur: IncomeStatement,
  cmp: IncomeStatement,
): IncomeStatementVariance {
  const lines = Object.fromEntries(
    LINE_KEYS.map((k) => [k, varianceLines(cur[k], cmp[k])]),
  ) as Record<(typeof LINE_KEYS)[number], VarianceLine[]>;
  return { ...moneyVariance(cur, cmp, TOTAL_KEYS), ...lines };
}

@Injectable()
export class IncomeStatementService {
  constructor(private readonly balances: BalancesService) {}

  private section(
    rows: AccountBalanceRow[],
    pred: (r: AccountBalanceRow) => boolean,
  ) {
    const lines: ReportLine[] = [];
    let total = Money.zero();
    for (const r of rows.filter(pred)) {
      const amt = naturalSide(r.type, Money.of(r.debit), Money.of(r.credit));
      total = total.add(amt);
      lines.push({ code: r.code, name: r.name, amount: amt.toPersistence() });
    }
    return { lines, total };
  }

  /** The Laba Rugi over [from, to]. With `compare`, both periods are read on
   *  ONE snapshot and the response gains `comparative` (the same report for
   *  the comparison period) and `variance` (current − comparative). */
  async generate(
    from: Date,
    to: Date,
    compare?: { from: Date; to: Date },
  ): Promise<
    IncomeStatement & {
      comparative?: IncomeStatement;
      variance?: IncomeStatementVariance;
    }
  > {
    if (!compare) return this.build(from, to);
    return this.balances.snapshot(async (tx) => {
      const current = await this.build(from, to, tx);
      const comparative = await this.build(compare.from, compare.to, tx);
      return {
        ...current,
        comparative,
        variance: incomeStatementVariance(current, comparative),
      };
    });
  }

  private async build(
    from: Date,
    to: Date,
    tx?: LedgerTx,
  ): Promise<IncomeStatement> {
    // Year-end CLOSING entries (and their reopen reversals) zero P&L; they are
    // not business activity, so they never appear on the Laba Rugi.
    const all = (
      await this.balances.movementsBetween(from, to, {
        excludeClosing: true,
        tx,
      })
    ).filter((r) => r.type === 'REVENUE' || r.type === 'EXPENSE');
    // Pull the income-tax-expense account out FIRST (whatever subtype it carries),
    // so it appears only on its own line and never double-counts in a subtype section.
    const taxRows = all.filter((r) => r.role === 'TAX_EXPENSE');
    const rows = all.filter((r) => r.role !== 'TAX_EXPENSE');
    const revenue = this.section(rows, (r) => r.subtype === 'REVENUE');
    const cogs = this.section(rows, (r) => r.subtype === 'COGS');
    const grossProfit = revenue.total.subtract(cogs.total);
    const opex = this.section(rows, (r) => r.subtype === 'OPERATING_EXPENSE');
    const operatingProfit = grossProfit.subtract(opex.total);
    const otherIncome = this.section(rows, (r) => r.subtype === 'OTHER_INCOME');
    const otherExpense = this.section(
      rows,
      (r) => r.subtype === 'OTHER_EXPENSE',
    );
    const profitBeforeTax = operatingProfit
      .add(otherIncome.total)
      .subtract(otherExpense.total);
    const tax = this.section(taxRows, () => true);
    const netIncome = profitBeforeTax.subtract(tax.total);

    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      revenue: revenue.total.toPersistence(),
      revenueLines: revenue.lines,
      cogs: cogs.total.toPersistence(),
      cogsLines: cogs.lines,
      grossProfit: grossProfit.toPersistence(),
      operatingExpense: opex.total.toPersistence(),
      operatingExpenseLines: opex.lines,
      operatingProfit: operatingProfit.toPersistence(),
      otherIncome: otherIncome.total.toPersistence(),
      otherIncomeLines: otherIncome.lines,
      otherExpense: otherExpense.total.toPersistence(),
      otherExpenseLines: otherExpense.lines,
      profitBeforeTax: profitBeforeTax.toPersistence(),
      taxExpense: tax.total.toPersistence(),
      taxExpenseLines: tax.lines,
      netIncome: netIncome.toPersistence(),
    };
  }
}
