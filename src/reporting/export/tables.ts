// src/reporting/export/tables.ts
// Pure mappers: report response → ReportTable (see render.ts). Money cells
// carry the report's exact decimal strings; nothing is recomputed here.
import type { TrialBalance } from '../../ledger/balances/balances.service';
import type {
  AgingReportDto,
  CashFlowDto,
  GeneralLedgerBookResponseDto,
  GeneralLedgerBookSectionDto,
  GeneralLedgerDto,
  IncomeStatementDto,
} from '../dto/report-response.dto';
import type {
  BalanceSheet,
  BalanceSheetVariance,
} from '../balance-sheet.service';
import { Cell, m, ReportTable, Row } from './render';

const bold = (cells: Cell[]): Row => ({ cells, bold: true });

// ------------------------------------------------------------ Neraca

const BS_SECTIONS = [
  ['ASET', 'assets', 'totalAssets'],
  ['LIABILITAS', 'liabilities', 'totalLiabilities'],
  ['EKUITAS', 'equity', 'totalEquity'],
] as const;

export function balanceSheetTable(
  r: BalanceSheet & {
    comparative?: BalanceSheet;
    variance?: BalanceSheetVariance;
  },
): ReportTable {
  const title = ['Neraca', `Per ${r.asOf}`];
  const notes = [`Seimbang: ${r.balanced ? 'ya' : 'TIDAK'}`];
  const { comparative: c, variance: v } = r;
  if (c && v) {
    const rows: Row[] = [];
    for (const [label, key, total] of BS_SECTIONS) {
      rows.push(bold([label]));
      for (const l of v[key])
        rows.push({
          cells: [
            l.subtype ?? '',
            l.code,
            l.name,
            m(l.current),
            m(l.comparative),
            m(l.variance),
          ],
        });
      rows.push(
        bold(['', '', `Total ${label}`, m(r[total]), m(c[total]), m(v[total])]),
      );
    }
    return {
      title: [...title, `Pembanding per ${c.asOf}`],
      header: ['Subtipe', 'Kode', 'Akun', r.asOf, c.asOf, 'Selisih'],
      rows,
      notes,
    };
  }
  const rows: Row[] = [];
  for (const [label, key, total] of BS_SECTIONS) {
    rows.push(bold([label]));
    for (const g of r[key].groups) {
      for (const l of g.lines)
        rows.push({ cells: [g.subtype, l.code, l.name, m(l.amount)] });
      rows.push(bold([g.subtype, '', `Subtotal ${g.subtype}`, m(g.subtotal)]));
    }
    rows.push(bold(['', '', `Total ${label}`, m(r[total])]));
  }
  return { title, header: ['Subtipe', 'Kode', 'Akun', 'Jumlah'], rows, notes };
}

// ------------------------------------------------------------ Laba Rugi

type IsLinesKey =
  | 'revenueLines'
  | 'cogsLines'
  | 'operatingExpenseLines'
  | 'otherIncomeLines'
  | 'otherExpenseLines'
  | 'taxExpenseLines';
type IsTotalKey = Exclude<
  keyof IncomeStatementDto,
  IsLinesKey | 'from' | 'to' | 'comparative' | 'variance'
>;

/** Each step: optional account lines, then its total row. */
const IS_STEPS: [string, IsLinesKey | null, IsTotalKey][] = [
  ['Pendapatan', 'revenueLines', 'revenue'],
  ['Harga Pokok Penjualan', 'cogsLines', 'cogs'],
  ['Laba Kotor', null, 'grossProfit'],
  ['Beban Operasional', 'operatingExpenseLines', 'operatingExpense'],
  ['Laba Operasional', null, 'operatingProfit'],
  ['Pendapatan Lain-lain', 'otherIncomeLines', 'otherIncome'],
  ['Beban Lain-lain', 'otherExpenseLines', 'otherExpense'],
  ['Laba Sebelum Pajak', null, 'profitBeforeTax'],
  ['Beban Pajak Penghasilan', 'taxExpenseLines', 'taxExpense'],
  ['Laba Bersih', null, 'netIncome'],
];

export function incomeStatementTable(r: IncomeStatementDto): ReportTable {
  const period = `${r.from} s.d. ${r.to}`;
  const { comparative: c, variance: v } = r;
  const rows: Row[] = [];
  if (c && v) {
    const cPeriod = `${c.from} s.d. ${c.to}`;
    for (const [label, lines, total] of IS_STEPS) {
      if (lines) {
        rows.push(bold([label]));
        for (const l of v[lines])
          rows.push({
            cells: [
              l.code,
              l.name,
              m(l.current),
              m(l.comparative),
              m(l.variance),
            ],
          });
      }
      const name = lines ? `Total ${label}` : label;
      rows.push(bold(['', name, m(r[total]), m(c[total]), m(v[total])]));
    }
    return {
      title: ['Laba Rugi', period, `Pembanding ${cPeriod}`],
      header: ['Kode', 'Akun', period, cPeriod, 'Selisih'],
      rows,
    };
  }
  for (const [label, lines, total] of IS_STEPS) {
    if (lines) {
      rows.push(bold([label]));
      for (const l of r[lines])
        rows.push({ cells: [l.code, l.name, m(l.amount)] });
    }
    rows.push(bold(['', lines ? `Total ${label}` : label, m(r[total])]));
  }
  return {
    title: ['Laba Rugi', period],
    header: ['Kode', 'Akun', 'Jumlah'],
    rows,
  };
}

// ------------------------------------------------------------ Neraca Saldo

export function trialBalanceTable(
  r: TrialBalance,
  preClosing = false,
): ReportTable {
  return {
    title: [
      'Neraca Saldo',
      `Per ${r.asOf}${preClosing ? ' (sebelum penutupan)' : ''}`,
    ],
    header: ['Kode', 'Akun', 'Debit', 'Kredit', 'Saldo'],
    rows: [
      ...r.rows.map((x) => ({
        cells: [x.code, x.name, m(x.debit), m(x.credit), m(x.balance)],
      })),
      bold(['', 'Total', m(r.totalDebit), m(r.totalCredit)]),
    ],
  };
}

// ------------------------------------------------------------ Buku Besar

const GL_HEADER = ['Tanggal', 'Ref', 'Keterangan', 'Debit', 'Kredit', 'Saldo'];

function ledgerRows(s: GeneralLedgerBookSectionDto): Row[] {
  return [
    bold(['', '', 'Saldo Awal', '', '', m(s.openingBalance)]),
    ...s.lines.map((l) => ({
      cells: [
        l.date,
        l.entryRef ?? '',
        l.description ?? '',
        m(l.debit),
        m(l.credit),
        m(l.runningBalance),
      ],
    })),
    bold(['', '', 'Saldo Akhir', '', '', m(s.closingBalance)]),
  ];
}

function truncationNote(r: {
  truncated: boolean;
  nextCursor: string | null;
}): string[] | undefined {
  return r.truncated
    ? [
        `TERPOTONG: halaman ini dibatasi 10.000 baris. Ambil sisanya dengan cursor=${r.nextCursor}. Saldo Akhir tetap saldo sebenarnya per tanggal akhir.`,
      ]
    : undefined;
}

export function generalLedgerTable(r: GeneralLedgerDto): ReportTable {
  return {
    title: [
      `Buku Besar ${r.account.code} ${r.account.name}`,
      `${r.from} s.d. ${r.to}`,
    ],
    header: GL_HEADER,
    rows: ledgerRows(r),
    notes: truncationNote(r),
  };
}

export function generalLedgerBookTable(
  r: GeneralLedgerBookResponseDto,
): ReportTable {
  return {
    title: ['Buku Besar', `${r.from} s.d. ${r.to}`],
    header: GL_HEADER,
    rows: r.accounts.flatMap((s) => [
      bold([s.account.code, '', s.account.name]),
      ...ledgerRows(s),
    ]),
    notes: truncationNote(r),
  };
}

// ------------------------------------------------------------ Umur Piutang/Utang

const BUCKETS = ['Current', '1-30', '31-60', '61-90', '>90'];

export function agingTable(r: AgingReportDto): ReportTable {
  const rows: Row[] = r.partners.flatMap((p) =>
    p.documents.map((d) => ({
      cells: [
        p.partnerName,
        d.ref ?? '',
        d.date,
        d.dueDate ?? '',
        m(d.total),
        m(d.paidAsOf),
        m(d.outstanding),
        d.bucket,
      ],
    })),
  );
  for (const b of BUCKETS)
    rows.push(
      bold([
        `Total ${b}`,
        '',
        '',
        '',
        '',
        '',
        m(r.totalsByBucket[b] ?? '0.0000'),
        b,
      ]),
    );
  rows.push(bold(['Total Sisa', '', '', '', '', '', m(r.totalOutstanding)]));
  const notes = [`Jumlah dokumen terbuka: ${r.documentCount}`];
  if (r.truncated)
    notes.push(
      `TERPOTONG: hanya sebagian mitra (batas 10.000 dokumen). Lanjutkan dengan afterPartnerId=${r.nextAfterPartnerId}. Total di atas mencakup SEMUA dokumen.`,
    );
  return {
    title: [r.kind === 'AR' ? 'Umur Piutang' : 'Umur Utang', `Per ${r.asOf}`],
    header: [
      'Mitra',
      'Ref',
      'Tanggal',
      'Jatuh Tempo',
      'Total',
      'Dibayar',
      'Sisa',
      'Umur',
    ],
    rows,
    notes,
  };
}

// ------------------------------------------------------------ Arus Kas

export function cashFlowTable(r: CashFlowDto): ReportTable {
  const lines = (ls: { code: string; name: string; amount: string }[]) =>
    ls.map((l) => ({ cells: [l.code, l.name, m(l.amount)] }));
  return {
    title: ['Arus Kas', `${r.from} s.d. ${r.to}`],
    header: ['Kode', 'Akun', 'Jumlah'],
    rows: [
      bold(['Aktivitas Operasi']),
      { cells: ['', 'Laba Bersih', m(r.netIncome)] },
      ...lines(r.operating.adjustments),
      bold(['', 'Total Aktivitas Operasi', m(r.operating.total)]),
      bold(['Aktivitas Investasi']),
      ...lines(r.investing.lines),
      bold(['', 'Total Aktivitas Investasi', m(r.investing.total)]),
      bold(['Aktivitas Pendanaan']),
      ...lines(r.financing.lines),
      bold(['', 'Total Aktivitas Pendanaan', m(r.financing.total)]),
      bold(['', 'Kenaikan (Penurunan) Bersih Kas', m(r.netChange)]),
      bold(['', 'Kas Awal', m(r.kasAwal)]),
      bold(['', 'Kas Akhir', m(r.kasAkhir)]),
    ],
    notes: [`Rekonsiliasi: ${r.reconciles ? 'ya' : 'TIDAK'}`],
  };
}
