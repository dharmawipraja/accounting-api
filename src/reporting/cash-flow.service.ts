import { Injectable } from '@nestjs/common';
import { Money } from '../common/money/money';
import {
  BalancesService,
  AccountBalanceRow,
} from '../ledger/balances/balances.service';
import { truncateToUtcDay } from '../common/dates/utc-day';
import type { LedgerTx } from '../common/prisma/prisma.service';

export interface CashFlowLine {
  code: string;
  name: string;
  amount: string;
}

@Injectable()
export class CashFlowService {
  constructor(private readonly balances: BalancesService) {}

  /** Cash provided by an account's movement = credit − debit. */
  private cashEffect(r: AccountBalanceRow): Money {
    return Money.of(r.credit).subtract(Money.of(r.debit));
  }

  private cashBalance(rows: AccountBalanceRow[]): Money {
    // Kas/Bank are debit-normal assets: balance = debit − credit.
    return rows
      .filter((r) => r.role === 'CASH')
      .reduce(
        (s, r) => s.add(Money.of(r.debit).subtract(Money.of(r.credit))),
        Money.zero(),
      );
  }

  /** All four aggregates read one snapshot (see BalancesService.snapshot). */
  generate(from: Date, to: Date) {
    return this.balances.snapshot((tx) => this.build(from, to, tx));
  }

  private async build(from: Date, to: Date, tx: LedgerTx) {
    // Flows exclude year-end CLOSING entries (P&L → Laba Ditahan is not cash
    // activity) and OPENING entries (beginning balances, folded into kasAwal).
    const movements = await this.balances.movementsBetween(from, to, {
      excludeClosing: true,
      excludeOpening: true,
      tx,
    });
    const nonCash = movements.filter((r) => r.role !== 'CASH');

    // Net income = Σ cash-effect of P&L accounts.
    const pl = nonCash.filter(
      (r) => r.type === 'REVENUE' || r.type === 'EXPENSE',
    );
    const netIncome = pl.reduce(
      (s, r) => s.add(this.cashEffect(r)),
      Money.zero(),
    );

    // Non-P&L, non-cash accounts grouped by cashFlowCategory (NONE → OPERATING).
    const bs = nonCash.filter(
      (r) => r.type !== 'REVENUE' && r.type !== 'EXPENSE',
    );
    const bucket = (cat: string): 'OPERATING' | 'INVESTING' | 'FINANCING' =>
      cat === 'INVESTING'
        ? 'INVESTING'
        : cat === 'FINANCING'
          ? 'FINANCING'
          : 'OPERATING';
    const sections: Record<string, { lines: CashFlowLine[]; total: Money }> = {
      OPERATING: { lines: [], total: Money.zero() },
      INVESTING: { lines: [], total: Money.zero() },
      FINANCING: { lines: [], total: Money.zero() },
    };
    for (const r of bs) {
      const amt = this.cashEffect(r);
      if (amt.isZero()) continue;
      const sec = sections[bucket(r.cashFlowCategory)];
      sec.lines.push({
        code: r.code,
        name: r.name,
        amount: amt.toPersistence(),
      });
      sec.total = sec.total.add(amt);
    }

    const operating = netIncome.add(sections.OPERATING.total);
    const investing = sections.INVESTING.total;
    const financing = sections.FINANCING.total;
    const netChange = operating.add(investing).add(financing);

    const dayBefore = new Date(truncateToUtcDay(from).getTime() - 86_400_000);
    // kasAwal = cash before the range + cash booked by OPENING entries inside
    // it (all movements minus the flow movements), so `reconciles` still ties.
    const allMovements = await this.balances.movementsBetween(from, to, {
      excludeClosing: true,
      tx,
    });
    const openingCash = this.cashBalance(allMovements).subtract(
      this.cashBalance(movements),
    );
    const kasAwal = this.cashBalance(
      await this.balances.balancesAsOf(dayBefore, { tx }),
    ).add(openingCash);
    const kasAkhir = this.cashBalance(
      await this.balances.balancesAsOf(to, { tx }),
    );

    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      netIncome: netIncome.toPersistence(),
      operating: {
        adjustments: sections.OPERATING.lines,
        total: operating.toPersistence(),
      },
      investing: {
        lines: sections.INVESTING.lines,
        total: investing.toPersistence(),
      },
      financing: {
        lines: sections.FINANCING.lines,
        total: financing.toPersistence(),
      },
      netChange: netChange.toPersistence(),
      kasAwal: kasAwal.toPersistence(),
      kasAkhir: kasAkhir.toPersistence(),
      reconciles: kasAwal.add(netChange).equals(kasAkhir),
    };
  }
}
