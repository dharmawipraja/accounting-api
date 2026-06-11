import { Injectable } from '@nestjs/common';
import { Money } from '../common/money/money';
import {
  BalancesService,
  AccountBalanceRow,
} from '../ledger/balances/balances.service';

const TAX_EXPENSE_CODE = '5-9000';
export interface ReportLine {
  code: string;
  name: string;
  amount: string;
}

@Injectable()
export class IncomeStatementService {
  constructor(private readonly balances: BalancesService) {}

  /** credit−debit for revenue/income; debit−credit for cost/expense. Magnitudes positive. */
  private mag(r: AccountBalanceRow): Money {
    const d = Money.of(r.debit);
    const c = Money.of(r.credit);
    return r.type === 'REVENUE' ? c.subtract(d) : d.subtract(c);
  }

  private section(
    rows: AccountBalanceRow[],
    pred: (r: AccountBalanceRow) => boolean,
  ) {
    const lines: ReportLine[] = [];
    let total = Money.zero();
    for (const r of rows.filter(pred)) {
      const amt = this.mag(r);
      total = total.add(amt);
      lines.push({ code: r.code, name: r.name, amount: amt.toPersistence() });
    }
    return { lines, total };
  }

  async generate(from: Date, to: Date) {
    const all = (await this.balances.movementsBetween(from, to)).filter(
      (r) => r.type === 'REVENUE' || r.type === 'EXPENSE',
    );
    // Pull the income-tax-expense account out FIRST (whatever subtype it carries),
    // so it appears only on its own line and never double-counts in a subtype section.
    const taxRows = all.filter((r) => r.code === TAX_EXPENSE_CODE);
    const rows = all.filter((r) => r.code !== TAX_EXPENSE_CODE);
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
      otherExpense: otherExpense.total.toPersistence(),
      profitBeforeTax: profitBeforeTax.toPersistence(),
      taxExpense: tax.total.toPersistence(),
      netIncome: netIncome.toPersistence(),
    };
  }
}
