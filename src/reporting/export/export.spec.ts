// src/reporting/export/export.spec.ts
import { Workbook } from 'exceljs';
import { m, ReportTable, toCsv, toXlsx, xlsxMoney } from './render';
import {
  agingTable,
  balanceSheetTable,
  cashFlowTable,
  generalLedgerBookTable,
  generalLedgerTable,
  incomeStatementTable,
  trialBalanceTable,
} from './tables';

const cells = (t: ReportTable) =>
  t.rows.map((r) => r.cells.map((c) => (typeof c === 'string' ? c : c.money)));

describe('toCsv', () => {
  const t: ReportTable = {
    title: ['Neraca'],
    header: ['Kode', 'Akun', 'Jumlah'],
    rows: [
      { cells: ['1-1000', 'Kas, "Besar"\nbaris 2', m('-1500.0000')] },
      { cells: ['=1+1', '+x', '-y', '@SUM(A1)', '\tt', '\rr', 'ok'] },
    ],
    notes: ['catatan'],
  };
  const csv = toCsv(t);

  it('starts with a UTF-8 BOM and uses CRLF rows', () => {
    expect(csv.startsWith('﻿Neraca\r\n\r\nKode,Akun,Jumlah\r\n')).toBe(true);
    expect(csv.endsWith('catatan\r\n')).toBe(true);
  });

  it('quotes commas, quotes and newlines (RFC 4180); money stays numeric', () => {
    expect(csv).toContain('1-1000,"Kas, ""Besar""\nbaris 2",-1500.0000\r\n');
  });

  it('prefixes formula-looking text with a single quote', () => {
    expect(csv).toContain("'=1+1,'+x,'-y,'@SUM(A1),'\tt,\"'\rr\",ok\r\n");
  });
});

describe('xlsxMoney', () => {
  it.each([
    ['0.0000', 0],
    ['-1500.5000', -1500.5],
    ['123456789012345.0000', 123456789012345],
    ['12345678901.2345', 12345678901.2345],
  ])('%s → number', (s, n) => expect(xlsxMoney(s)).toBe(n));

  it.each(['1234567890123456.0000', '123456789012.3456'])(
    '%s (>15 significant digits) stays an exact string',
    (s) => expect(xlsxMoney(s)).toBe(s),
  );
});

describe('toXlsx', () => {
  it('writes typed money cells, bold totals and a frozen header', async () => {
    const buf = await toXlsx({
      title: ['T'],
      header: ['Akun', 'Jumlah'],
      rows: [
        { cells: ['=evil', m('-1500.5000')] },
        { cells: ['Total', m('1234567890123456.7891')], bold: true },
      ],
    });
    const wb = new Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 3 });
    expect(ws.getCell('A3').font?.bold).toBe(true);
    expect(ws.getCell('A4').value).toBe('=evil'); // a string, not a formula
    expect(ws.getCell('A4').type).toBe(3); // ValueType.String
    expect(ws.getCell('B4').value).toBe(-1500.5);
    expect(ws.getCell('B4').numFmt).toBe('#,##0.00;(#,##0.00)');
    expect(ws.getCell('B5').value).toBe('1234567890123456.7891');
    expect(ws.getCell('A5').font?.bold).toBe(true);
  });
});

describe('report mappers', () => {
  const bs = {
    asOf: '2026-01-31',
    assets: {
      groups: [
        {
          subtype: 'CURRENT_ASSET',
          lines: [{ code: '1-1000', name: 'Kas', amount: '100.0000' }],
          subtotal: '100.0000',
        },
      ],
      total: '100.0000',
    },
    liabilities: { groups: [], total: '0.0000' },
    equity: {
      groups: [
        {
          subtype: 'EQUITY',
          lines: [{ code: '', name: 'Laba Berjalan', amount: '100.0000' }],
          subtotal: '100.0000',
        },
      ],
      total: '100.0000',
    },
    totalAssets: '100.0000',
    totalLiabilities: '0.0000',
    totalEquity: '100.0000',
    currentYearEarnings: '100.0000',
    unclosedPriorYearsEarnings: '0.0000',
    balanced: true,
  };

  it('balance sheet: lines, subtotals, totals', () => {
    const t = balanceSheetTable(bs);
    expect(t.header).toEqual(['Subtipe', 'Kode', 'Akun', 'Jumlah']);
    expect(cells(t)).toContainEqual([
      'CURRENT_ASSET',
      '1-1000',
      'Kas',
      '100.0000',
    ]);
    expect(cells(t)).toContainEqual(['', '', 'Total ASET', '100.0000']);
  });

  it('balance sheet comparative: current / comparative / variance columns', () => {
    const v = {
      totalAssets: '40.0000',
      totalLiabilities: '0.0000',
      totalEquity: '40.0000',
      currentYearEarnings: '40.0000',
      unclosedPriorYearsEarnings: '0.0000',
      assets: [
        {
          subtype: 'CURRENT_ASSET',
          code: '1-1000',
          name: 'Kas',
          current: '100.0000',
          comparative: '60.0000',
          variance: '40.0000',
        },
      ],
      liabilities: [],
      equity: [],
    };
    const cmp = { ...bs, asOf: '2025-12-31', totalAssets: '60.0000' };
    const t = balanceSheetTable({ ...bs, comparative: cmp, variance: v });
    expect(t.header).toEqual([
      'Subtipe',
      'Kode',
      'Akun',
      '2026-01-31',
      '2025-12-31',
      'Selisih',
    ]);
    expect(cells(t)).toContainEqual([
      '',
      '',
      'Total ASET',
      '100.0000',
      '60.0000',
      '40.0000',
    ]);
  });

  const is = {
    from: '2026-01-01',
    to: '2026-01-31',
    revenue: '500.0000',
    revenueLines: [{ code: '4-1000', name: 'Penjualan', amount: '500.0000' }],
    cogs: '0.0000',
    cogsLines: [],
    grossProfit: '500.0000',
    operatingExpense: '0.0000',
    operatingExpenseLines: [],
    operatingProfit: '500.0000',
    otherIncome: '0.0000',
    otherIncomeLines: [],
    otherExpense: '0.0000',
    otherExpenseLines: [],
    profitBeforeTax: '500.0000',
    taxExpense: '0.0000',
    taxExpenseLines: [],
    netIncome: '500.0000',
  };

  it('income statement: every step incl. other income/expense and tax', () => {
    const labels = cells(incomeStatementTable(is)).map((r) => r[1]);
    expect(labels).toEqual(
      expect.arrayContaining([
        'Penjualan',
        'Total Pendapatan Lain-lain',
        'Total Beban Lain-lain',
        'Laba Sebelum Pajak',
        'Total Beban Pajak Penghasilan',
        'Laba Bersih',
      ]),
    );
    expect(cells(incomeStatementTable(is))).toContainEqual([
      '',
      'Laba Bersih',
      '500.0000',
    ]);
  });

  it('income statement comparative uses variance lines + 3 totals', () => {
    const vLines = Object.fromEntries(
      [
        'revenueLines',
        'cogsLines',
        'operatingExpenseLines',
        'otherIncomeLines',
        'otherExpenseLines',
        'taxExpenseLines',
      ].map((k) => [k, []]),
    );
    const t = incomeStatementTable({
      ...is,
      comparative: { ...is, from: '2025-01-01', to: '2025-01-31' },
      variance: {
        ...is,
        ...vLines,
        revenueLines: [
          {
            code: '4-1000',
            name: 'Penjualan',
            current: '500.0000',
            comparative: '500.0000',
            variance: '0.0000',
          },
        ],
        netIncome: '0.0000',
      },
    });
    expect(t.header).toHaveLength(5);
    expect(cells(t)).toContainEqual([
      '',
      'Laba Bersih',
      '500.0000',
      '500.0000',
      '0.0000',
    ]);
  });

  it('trial balance: rows + totals, pre-closing title', () => {
    const t = trialBalanceTable(
      {
        asOf: '2026-12-31',
        rows: [
          {
            accountId: 'a',
            code: '1-1000',
            name: 'Kas',
            debit: '5.0000',
            credit: '0.0000',
            balance: '5.0000',
          },
        ],
        totalDebit: '5.0000',
        totalCredit: '5.0000',
      },
      true,
    );
    expect(t.title[1]).toContain('sebelum penutupan');
    expect(cells(t).slice(-1)[0]).toEqual(['', 'Total', '5.0000', '5.0000']);
  });

  const account = {
    id: 'a',
    code: '1-1000',
    name: 'Kas',
    normalBalance: 'DEBIT',
  };
  const line = {
    date: '2026-01-02',
    entryRef: 'JE-1',
    description: '=HYPERLINK("x")',
    debit: '5.0000',
    credit: '0.0000',
    runningBalance: '5.0000',
  };

  it('general ledger: opening, lines, closing; truncation note', () => {
    const r = {
      account,
      from: '2026-01-01',
      to: '2026-01-31',
      openingBalance: '0.0000',
      lines: [line],
      closingBalance: '9.0000',
      truncated: true,
      nextCursor: 'abc',
    };
    const t = generalLedgerTable(r);
    expect(cells(t)[0]).toEqual(['', '', 'Saldo Awal', '', '', '0.0000']);
    expect(cells(t).slice(-1)[0]).toEqual([
      '',
      '',
      'Saldo Akhir',
      '',
      '',
      '9.0000',
    ]);
    expect(t.notes?.[0]).toContain('cursor=abc');
    expect(
      generalLedgerTable({ ...r, truncated: false, nextCursor: null }).notes,
    ).toBeUndefined();
  });

  it('general ledger book: one block per account', () => {
    const section = {
      account,
      openingBalance: '0.0000',
      lines: [line],
      closingBalance: '5.0000',
    };
    const t = generalLedgerBookTable({
      from: '2026-01-01',
      to: '2026-01-31',
      accounts: [section, { ...section, account: { ...account, code: '1-2' } }],
      truncated: false,
      nextCursor: null,
    });
    expect(cells(t).filter((r) => r[2] === 'Saldo Akhir')).toHaveLength(2);
    expect(cells(t)[0]).toEqual(['1-1000', '', 'Kas']);
  });

  it('aging: document rows, bucket totals, truncation note', () => {
    const t = agingTable({
      kind: 'AR',
      asOf: '2026-01-31',
      truncated: true,
      nextAfterPartnerId: 'p2',
      partners: [
        {
          partnerId: 'p1',
          partnerName: 'PT A',
          documents: [
            {
              ref: 'INV-1',
              date: '2026-01-01',
              dueDate: null,
              total: '10.0000',
              paidAsOf: '0.0000',
              outstanding: '10.0000',
              bucket: '1-30',
            },
          ],
          buckets: {},
        },
      ],
      totalsByBucket: { '1-30': '10.0000' },
      totalOutstanding: '10.0000',
      documentCount: 3,
    });
    expect(t.title[0]).toBe('Umur Piutang');
    expect(cells(t)[0]).toEqual([
      'PT A',
      'INV-1',
      '2026-01-01',
      '',
      '10.0000',
      '0.0000',
      '10.0000',
      '1-30',
    ]);
    expect(cells(t)).toContainEqual([
      'Total Sisa',
      '',
      '',
      '',
      '',
      '',
      '10.0000',
    ]);
    expect(t.notes?.join(' ')).toContain('afterPartnerId=p2');
  });

  it('cash flow: sections and kas awal/akhir', () => {
    const t = cashFlowTable({
      from: '2026-01-01',
      to: '2026-01-31',
      netIncome: '5.0000',
      operating: {
        adjustments: [{ code: '1-2000', name: 'Piutang', amount: '-1.0000' }],
        total: '4.0000',
      },
      investing: { lines: [], total: '0.0000' },
      financing: { lines: [], total: '0.0000' },
      netChange: '4.0000',
      kasAwal: '1.0000',
      kasAkhir: '5.0000',
      reconciles: true,
    });
    expect(cells(t)).toContainEqual(['1-2000', 'Piutang', '-1.0000']);
    expect(cells(t).slice(-1)[0]).toEqual(['', 'Kas Akhir', '5.0000']);
  });
});
