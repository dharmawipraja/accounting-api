import request from 'supertest';
import { type App } from 'supertest/types';
import { INestApplication } from '@nestjs/common';
import { Workbook } from 'exceljs';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { SalesInvoicesService } from '../src/invoicing/sales-invoices.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';
import type {
  AgingReportDto,
  BalanceSheetDto,
  CashFlowDto,
  GeneralLedgerBookResponseDto,
  GeneralLedgerDto,
  IncomeStatementDto,
} from '../src/reporting/dto/report-response.dto';
import type { TrialBalanceDto } from '../src/ledger/balances/dto/balance-response.dto';

/** Minimal RFC 4180 parser (quoted fields, "" escapes, CRLF rows). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else field += ch;
  }
  return rows;
}

async function parseXlsx(buf: Buffer): Promise<string[][]> {
  const wb = new Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  const rows: string[][] = [];
  for (let i = 1; i <= ws.rowCount; i++) {
    const r = ws.getRow(i);
    rows.push(
      Array.from({ length: ws.columnCount }, (_, j) => {
        const v = r.getCell(j + 1).value;
        if (v === null || v === undefined) return '';
        if (typeof v === 'string' || typeof v === 'number') return String(v);
        throw new Error(`unexpected cell value at row ${i}`);
      }),
    );
  }
  return rows;
}

const binary = (
  res: unknown,
  cb: (err: Error | null, body: Buffer) => void,
) => {
  const stream = res as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
};

/** The row whose column `col` equals `label`. */
const rowOf = (rows: string[][], col: number, label: string) => {
  const r = rows.find((x) => x[col] === label);
  if (!r) throw new Error(`no row "${label}"`);
  return r;
};
const num = (s: string) => Number(s);

/**
 * CSV / XLSX export of every report: headers, filename, and file contents
 * that tie to the JSON report's totals.
 */
describe('Reporting export csv/xlsx (e2e)', () => {
  let app: INestApplication;
  let cleanup: () => Promise<void>;
  let token: string;
  let kasId: string;

  const get = (url: string) =>
    request(app.getHttpServer() as App)
      .get(url)
      .set('Authorization', `Bearer ${token}`);

  /** JSON body, the CSV rows and the XLSX rows of one report URL. */
  async function fetchAll<T>(url: string, filename: string) {
    const sep = url.includes('?') ? '&' : '?';
    const json = (await get(url).expect(200)).body as T;

    const csv = await get(`${url}${sep}format=csv`).expect(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toBe(
      `attachment; filename="${filename}.csv"`,
    );
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);

    const xlsx = await get(`${url}${sep}format=xlsx`)
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(xlsx.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(xlsx.headers['content-disposition']).toBe(
      `attachment; filename="${filename}.xlsx"`,
    );
    return {
      json,
      sheets: [
        parseCsv(csv.text.slice(1)),
        await parseXlsx(xlsx.body as Buffer),
      ],
    };
  }

  beforeAll(async () => {
    ({ app, cleanup } = await bootstrapTestApp());
    await app.get(CompanyService).seedIfEmpty();
    await app.get(AccountsService).seedIfEmpty();
    await app.get(TaxCodesService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const users = app.get(UsersService);
    const acct = await users.create({
      email: 'a@export.test',
      password: 'secret123',
      name: 'A',
      role: 'ACCOUNTANT',
    });
    const appr = await users.create({
      email: 'p@export.test',
      password: 'secret123',
      name: 'P',
      role: 'APPROVER',
    });
    await users.create({
      email: 'v@export.test',
      password: 'secret123',
      name: 'V',
      role: 'VIEWER',
    });
    token = (await app.get(AuthService).login('v@export.test', 'secret123'))
      .accessToken;
    const { data: accounts } = await app.get(AccountsService).list();
    const acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    kasId = acc['1-1000'];
    const { data: codes } = await app.get(TaxCodesService).list();
    const code = Object.fromEntries(codes.map((c) => [c.code, c.id]));

    const posting = app.get(PostingService);
    const post = (
      date: string,
      dr: string,
      cr: string,
      amount: string,
      description = `${dr}/${cr}`,
    ) =>
      posting.post(
        {
          date: new Date(date),
          description,
          sourceType: 'MANUAL',
          createdBy: 'a',
          lines: [
            { accountId: acc[dr], debit: amount },
            { accountId: acc[cr], credit: amount, description },
          ],
        },
        'p',
      );
    await post('2026-01-01', '1-1000', '3-1000', '10000000');
    await post('2026-01-15', '1-1000', '4-1000', '2000000');
    await post('2026-02-05', '5-2000', '1-1000', '500000', '=cmd|calc');
    await post('2026-02-06', '1-1000', '4-1000', '750000.1234');

    const customer = await app.get(BusinessPartnersService).create({
      code: 'CUST-EXP-1',
      name: 'PT "Koma", Tbk',
      isCustomer: true,
    });
    const invoices = app.get(SalesInvoicesService);
    const draft = await invoices.createDraft({
      partnerId: customer.id,
      date: new Date('2026-02-10'),
      dueDate: new Date('2026-02-20'),
      description: 'Invoice ekspor',
      lines: [
        {
          description: 'Jasa',
          accountId: acc['4-1000'],
          quantity: '1',
          unitPrice: '1000000',
          taxCodeIds: [code['PPN-OUT-11']],
        },
      ],
      createdBy: acct.id,
    });
    await invoices.post(draft.id, appr.id);
  }, 120_000);

  afterAll(() => cleanup());

  it('JSON stays the default (no attachment)', async () => {
    const res = await get('/v1/reports/balance-sheet?asOf=2026-02-28').expect(
      200,
    );
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect((res.body as BalanceSheetDto).totalAssets).toBeDefined();
  });

  it.each([
    '/v1/reports/balance-sheet?format=pdf',
    '/v1/ledger/trial-balance?format=CSV',
    '/v1/reports/cash-flow?from=2026-01-01&to=2026-02-28&format=',
  ])('unknown format → 400 (%s)', async (url) => {
    await get(url).expect(400);
  });

  it('balance sheet', async () => {
    const { json, sheets } = await fetchAll<BalanceSheetDto>(
      '/v1/reports/balance-sheet?asOf=2026-02-28',
      'balance-sheet-2026-02-28',
    );
    for (const rows of sheets) {
      expect(rows[0][0]).toBe('Neraca');
      expect(num(rowOf(rows, 2, 'Total ASET')[3])).toBe(num(json.totalAssets));
      expect(num(rowOf(rows, 2, 'Total EKUITAS')[3])).toBe(
        num(json.totalEquity),
      );
      expect(num(rowOf(rows, 1, '1-1000')[3])).toBe(12250000.1234);
    }
  });

  it('balance sheet comparative: comparison + variance columns', async () => {
    const { json, sheets } = await fetchAll<BalanceSheetDto>(
      '/v1/reports/balance-sheet?asOf=2026-02-28&compareAsOf=2026-01-31',
      'balance-sheet-2026-02-28',
    );
    for (const rows of sheets) {
      expect(rows[4]).toEqual(
        expect.arrayContaining(['2026-02-28', '2026-01-31', 'Selisih']),
      );
      const t = rowOf(rows, 2, 'Total ASET');
      expect(t.slice(3, 6).map(num)).toEqual([
        num(json.totalAssets),
        num(json.comparative!.totalAssets),
        num(json.variance!.totalAssets),
      ]);
    }
  });

  it('income statement (plain and comparative)', async () => {
    const plain = await fetchAll<IncomeStatementDto>(
      '/v1/reports/income-statement?from=2026-02-01&to=2026-02-28',
      'income-statement-2026-02-01_2026-02-28',
    );
    for (const rows of plain.sheets) {
      expect(num(rowOf(rows, 1, 'Laba Bersih')[2])).toBe(
        num(plain.json.netIncome),
      );
      expect(num(rowOf(rows, 1, 'Total Pendapatan')[2])).toBe(
        num(plain.json.revenue),
      );
      rowOf(rows, 1, 'Laba Sebelum Pajak');
      rowOf(rows, 1, 'Total Pendapatan Lain-lain');
    }
    const cmp = await fetchAll<IncomeStatementDto>(
      '/v1/reports/income-statement?from=2026-02-01&to=2026-02-28&compareFrom=2026-01-01&compareTo=2026-01-31',
      'income-statement-2026-02-01_2026-02-28',
    );
    for (const rows of cmp.sheets) {
      expect(rows[4]).toContain('Selisih');
      expect(rowOf(rows, 1, 'Laba Bersih').slice(2, 5).map(num)).toEqual([
        num(cmp.json.netIncome),
        num(cmp.json.comparative!.netIncome),
        num(cmp.json.variance!.netIncome),
      ]);
    }
  });

  it('trial balance (preClosing)', async () => {
    const { json, sheets } = await fetchAll<TrialBalanceDto>(
      '/v1/ledger/trial-balance?asOf=2026-02-28&preClosing=true',
      'trial-balance-2026-02-28',
    );
    for (const rows of sheets) {
      expect(rows[1][0]).toContain('sebelum penutupan');
      const t = rowOf(rows, 1, 'Total');
      expect([num(t[2]), num(t[3])]).toEqual([
        num(json.totalDebit),
        num(json.totalCredit),
      ]);
      expect(rows.filter((r) => /^\d-\d{4}$/.test(r[0]))).toHaveLength(
        json.rows.length,
      );
    }
  });

  it('general ledger: balances tie, formula text neutralised in CSV', async () => {
    const { json, sheets } = await fetchAll<GeneralLedgerDto>(
      `/v1/reports/general-ledger?accountId=${kasId}&from=2026-01-01&to=2026-02-28`,
      'general-ledger-2026-01-01_2026-02-28',
    );
    const [csv, xlsx] = sheets;
    for (const rows of sheets) {
      expect(num(rowOf(rows, 2, 'Saldo Akhir')[5])).toBe(
        num(json.closingBalance),
      );
      expect(num(rowOf(rows, 2, 'Saldo Awal')[5])).toBe(
        num(json.openingBalance),
      );
    }
    expect(csv.some((r) => r[2] === "'=cmd|calc")).toBe(true);
    expect(xlsx.some((r) => r[2] === '=cmd|calc')).toBe(true); // a string cell
  });

  it('general ledger book', async () => {
    const { json, sheets } = await fetchAll<GeneralLedgerBookResponseDto>(
      '/v1/reports/general-ledger/book?fromCode=1-1000&toCode=1-1000&from=2026-01-01&to=2026-02-28',
      'general-ledger-book-2026-01-01_2026-02-28',
    );
    for (const rows of sheets) {
      const closings = rows.filter((r) => r[2] === 'Saldo Akhir');
      expect(closings.map((r) => num(r[5]))).toEqual(
        json.accounts.map((a) => num(a.closingBalance)),
      );
    }
  });

  it('cash flow', async () => {
    const { json, sheets } = await fetchAll<CashFlowDto>(
      '/v1/reports/cash-flow?from=2026-01-01&to=2026-02-28',
      'cash-flow-2026-01-01_2026-02-28',
    );
    for (const rows of sheets) {
      expect(num(rowOf(rows, 1, 'Kas Akhir')[2])).toBe(num(json.kasAkhir));
      expect(num(rowOf(rows, 1, 'Laba Bersih')[2])).toBe(num(json.netIncome));
    }
  });

  it.each(['ar', 'ap'])('%s aging', async (kind) => {
    const { json, sheets } = await fetchAll<AgingReportDto>(
      `/v1/reports/${kind}-aging?asOf=2026-03-31`,
      `${kind}-aging-2026-03-31`,
    );
    for (const rows of sheets) {
      expect(num(rowOf(rows, 0, 'Total Sisa')[6])).toBe(
        num(json.totalOutstanding),
      );
      const docs = rows.filter((r) => r[0] === 'PT "Koma", Tbk');
      expect(docs).toHaveLength(kind === 'ar' ? 1 : 0);
    }
  });
});
