import { Injectable } from '@nestjs/common';
import { Money } from '../common/money/money';
import {
  BalancesService,
  AccountBalanceRow,
} from '../ledger/balances/balances.service';
import { naturalSide } from '../ledger/balances/signing';
import { CompanyService } from '../company/company.service';
import type { LedgerTx } from '../common/prisma/prisma.service';
import {
  ReportLine,
  VarianceLine,
  moneyVariance,
  varianceLines,
} from './report-line';

export interface ReportGroup {
  subtype: string;
  lines: ReportLine[];
  subtotal: string;
}

export interface ReportSection {
  groups: ReportGroup[];
  total: string;
}

export interface BalanceSheet {
  asOf: string;
  assets: ReportSection;
  liabilities: ReportSection;
  equity: ReportSection;
  totalAssets: string;
  totalLiabilities: string;
  totalEquity: string;
  currentYearEarnings: string;
  unclosedPriorYearsEarnings: string;
  balanced: boolean;
}

const TOTAL_KEYS = [
  'totalAssets',
  'totalLiabilities',
  'totalEquity',
  'currentYearEarnings',
  'unclosedPriorYearsEarnings',
] as const;

export type BalanceSheetVariance = Record<
  (typeof TOTAL_KEYS)[number],
  string
> & {
  assets: VarianceLine[];
  liabilities: VarianceLine[];
  equity: VarianceLine[];
};

/** Every line of a section, tagged with its subtype group. */
const flatLines = (s: ReportSection) =>
  s.groups.flatMap((g) => g.lines.map((l) => ({ ...l, subtype: g.subtype })));

/** current − comparative for every total, and per (subtype, account) line. */
export function balanceSheetVariance(
  cur: BalanceSheet,
  cmp: BalanceSheet,
): BalanceSheetVariance {
  const section = (k: 'assets' | 'liabilities' | 'equity') =>
    varianceLines(flatLines(cur[k]), flatLines(cmp[k]));
  return {
    ...moneyVariance(cur, cmp, TOTAL_KEYS),
    assets: section('assets'),
    liabilities: section('liabilities'),
    equity: section('equity'),
  };
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

  /** The Neraca as of a date. With `compareAsOf`, both dates are read on ONE
   *  snapshot and the response gains `comparative` (the same report as of
   *  compareAsOf) and `variance` (current − comparative). */
  async generate(
    asOf: Date,
    compareAsOf?: Date,
  ): Promise<
    BalanceSheet & {
      comparative?: BalanceSheet;
      variance?: BalanceSheetVariance;
    }
  > {
    const fyStart = await this.fiscalYearStart(asOf);
    const cmpFyStart = compareAsOf && (await this.fiscalYearStart(compareAsOf));
    return this.balances.snapshot(async (tx) => {
      const current = await this.build(asOf, fyStart, tx);
      if (!compareAsOf || !cmpFyStart) return current;
      const comparative = await this.build(compareAsOf, cmpFyStart, tx);
      return {
        ...current,
        comparative,
        variance: balanceSheetVariance(current, comparative),
      };
    });
  }

  private async fiscalYearStart(asOf: Date): Promise<Date> {
    const fy = await this.company.fiscalYearFor(asOf);
    return (await this.company.fiscalYearBounds(fy)).start;
  }

  private async build(
    asOf: Date,
    fyStart: Date,
    tx: LedgerTx,
  ): Promise<BalanceSheet> {
    // Pre-closing view: a closing entry dated ON the report date (the fiscal
    // year-end) is left out, so Laba (Rugi) Berjalan shows the year's profit
    // and Laba Ditahan excludes it; earlier years' closings still count.
    // Both aggregates read one snapshot (see BalancesService.snapshot), so the
    // current-year earnings sub-figure always matches the balances.
    const rows = await this.balances.balancesAsOf(asOf, {
      excludeClosingFrom: asOf,
      tx,
    });
    const fyRows = await this.balances.movementsBetween(fyStart, asOf, {
      excludeClosing: true,
      tx,
    });
    const assets = this.group(rows.filter((r) => r.type === 'ASSET'));
    const liabilities = this.group(rows.filter((r) => r.type === 'LIABILITY'));
    const equityRows = rows.filter((r) => r.type === 'EQUITY');
    const eq = this.group(equityRows);

    // Cumulative earnings = Σ(credit − debit) over all P&L rows (revenue − expense)
    // still open (not swept to Laba Ditahan by a counted closing entry).
    const pl = rows.filter((r) => r.type === 'REVENUE' || r.type === 'EXPENSE');
    const cumulativeEarnings = pl.reduce(
      (s, r) => s.add(Money.of(r.credit).subtract(Money.of(r.debit))),
      Money.zero(),
    );
    // Current-FY portion: FY-to-date P&L movement, closings excluded. Every
    // CLOSING entry (or reopen reversal) counted in `rows` belongs to an
    // EARLIER fiscal year (this year's closing is dated at its year-end ≥ asOf
    // → excluded above), so the remainder is exactly the P&L of earlier fiscal
    // years that were never closed (or were reopened). SAK presents that as
    // retained earnings, not as current-year profit.
    const currentYearEarnings = fyRows
      .filter((r) => r.type === 'REVENUE' || r.type === 'EXPENSE')
      .reduce(
        (s, r) => s.add(Money.of(r.credit).subtract(Money.of(r.debit))),
        Money.zero(),
      );
    const unclosedPriorYearsEarnings =
      cumulativeEarnings.subtract(currentYearEarnings);

    const line = (subtype: string, name: string, amount: Money) => ({
      subtype,
      lines: [{ code: '', name, amount: amount.toPersistence() }],
      subtotal: amount.toPersistence(),
    });
    const equityGroups = [
      ...eq.groups,
      // Only when non-zero, so a ledger whose prior years are all closed
      // keeps its exact previous shape.
      ...(unclosedPriorYearsEarnings.isZero()
        ? []
        : [
            line(
              'UNCLOSED_PRIOR_EARNINGS',
              'Laba Ditahan (tahun belum ditutup)',
              unclosedPriorYearsEarnings,
            ),
          ]),
      line('CURRENT_EARNINGS', 'Laba (Rugi) Berjalan', currentYearEarnings),
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
      unclosedPriorYearsEarnings: unclosedPriorYearsEarnings.toPersistence(),
      balanced: assets.total.equals(liabilities.total.add(totalEquity)),
    };
  }
}
