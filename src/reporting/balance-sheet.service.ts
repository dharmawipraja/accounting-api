import { Injectable } from '@nestjs/common';
import { Money } from '../common/money/money';
import {
  BalancesService,
  AccountBalanceRow,
} from '../ledger/balances/balances.service';
import { naturalSide } from '../ledger/balances/signing';
import { CompanyService } from '../company/company.service';
import { ReportLine } from './report-line';

export interface ReportGroup {
  subtype: string;
  lines: ReportLine[];
  subtotal: string;
}

@Injectable()
export class BalanceSheetService {
  constructor(
    private readonly balances: BalancesService,
    private readonly company: CompanyService,
  ) {}

  private group(rows: AccountBalanceRow[]): {
    groups: ReportGroup[];
    total: Money;
  } {
    const bySubtype = new Map<string, ReportLine[]>();
    let total = Money.zero();
    for (const r of rows) {
      const amt = naturalSide(r.type, Money.of(r.debit), Money.of(r.credit));
      total = total.add(amt);
      const lines = bySubtype.get(r.subtype) ?? [];
      lines.push({ code: r.code, name: r.name, amount: amt.toPersistence() });
      bySubtype.set(r.subtype, lines);
    }
    const groups: ReportGroup[] = [...bySubtype.entries()].map(
      ([subtype, lines]) => ({
        subtype,
        lines,
        subtotal: lines
          .reduce((s, l) => s.add(Money.of(l.amount)), Money.zero())
          .toPersistence(),
      }),
    );
    return { groups, total };
  }

  async generate(asOf: Date) {
    const fy = await this.company.fiscalYearFor(asOf);
    const { start: fyStart } = await this.company.fiscalYearBounds(fy);

    const rows = await this.balances.balancesAsOf(asOf);
    const assets = this.group(rows.filter((r) => r.type === 'ASSET'));
    const liabilities = this.group(rows.filter((r) => r.type === 'LIABILITY'));
    const equityRows = rows.filter((r) => r.type === 'EQUITY');
    const eq = this.group(equityRows);

    // Cumulative earnings = Σ(credit − debit) over all P&L rows (revenue − expense).
    const pl = rows.filter((r) => r.type === 'REVENUE' || r.type === 'EXPENSE');
    const cumulativeEarnings = pl.reduce(
      (s, r) => s.add(Money.of(r.credit).subtract(Money.of(r.debit))),
      Money.zero(),
    );
    // Current-FY portion (sub-figure).
    const fyRows = await this.balances.movementsBetween(fyStart, asOf);
    const currentYearEarnings = fyRows
      .filter((r) => r.type === 'REVENUE' || r.type === 'EXPENSE')
      .reduce(
        (s, r) => s.add(Money.of(r.credit).subtract(Money.of(r.debit))),
        Money.zero(),
      );

    const equityGroups = [
      ...eq.groups,
      {
        subtype: 'CURRENT_EARNINGS',
        lines: [
          {
            code: '',
            name: 'Laba (Rugi) Berjalan',
            amount: cumulativeEarnings.toPersistence(),
          },
        ],
        subtotal: cumulativeEarnings.toPersistence(),
      },
    ];
    const totalEquity = eq.total.add(cumulativeEarnings);

    return {
      asOf: asOf.toISOString().slice(0, 10),
      assets: { groups: assets.groups, total: assets.total.toPersistence() },
      liabilities: {
        groups: liabilities.groups,
        total: liabilities.total.toPersistence(),
      },
      equity: { groups: equityGroups, total: totalEquity.toPersistence() },
      totalAssets: assets.total.toPersistence(),
      totalLiabilities: liabilities.total.toPersistence(),
      totalEquity: totalEquity.toPersistence(),
      currentYearEarnings: currentYearEarnings.toPersistence(),
      balanced: assets.total.equals(liabilities.total.add(totalEquity)),
    };
  }
}
