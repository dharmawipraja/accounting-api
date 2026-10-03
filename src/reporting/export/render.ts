// src/reporting/export/render.ts
import { applyDecorators, StreamableFile, Type } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiPropertyOptional,
  ApiProduces,
  getSchemaPath,
} from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { Workbook } from 'exceljs';

/** A money cell: an exact decimal string (e.g. "-1500.0000"). Kept apart from
 *  text so it stays numeric (never formula-escaped) in CSV and XLSX. */
export interface MoneyCell {
  money: string;
}
export type Cell = string | MoneyCell;
export const m = (money: string): MoneyCell => ({ money });

export interface Row {
  cells: Cell[];
  bold?: boolean;
}

/** One report as a sheet: title rows, one header row, body rows, notes. */
export interface ReportTable {
  title: string[];
  header: string[];
  rows: Row[];
  notes?: string[];
}

export const EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** The optional `?format=` query field shared by every report DTO. */
export function ExportFormatField(): PropertyDecorator {
  return applyDecorators(
    ApiPropertyOptional({
      enum: EXPORT_FORMATS,
      description:
        'Download the report as a file instead of JSON: csv (UTF-8 with BOM) or xlsx. Omit for JSON.',
    }),
    IsOptional(),
    IsIn(EXPORT_FORMATS),
  );
}

const XLSX_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CSV_TYPE = 'text/csv; charset=utf-8';

/** OpenAPI: JSON body `type`, or the csv / xlsx download. */
export function ApiReportResponse(type: Type<unknown>): MethodDecorator {
  return applyDecorators(
    ApiExtraModels(type),
    ApiProduces('application/json', 'text/csv', XLSX_TYPE),
    ApiOkResponse({
      description:
        'The report as JSON, or with ?format=csv|xlsx an attachment (Content-Disposition filename).',
      content: {
        'application/json': { schema: { $ref: getSchemaPath(type) } },
        'text/csv': { schema: { type: 'string' } },
        [XLSX_TYPE]: { schema: { type: 'string', format: 'binary' } },
      },
    }),
  );
}

// ---------------------------------------------------------------- CSV

/** Text starting with one of these is a formula to Excel / Sheets. */
const FORMULA_START = /^[=+\-@\t\r]/;

function csvField(cell: Cell): string {
  let s = typeof cell === 'string' ? cell : cell.money;
  if (typeof cell === 'string' && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const tableRows = (t: ReportTable): Cell[][] => [
  ...t.title.map((x) => [x]),
  [],
  t.header,
  ...t.rows.map((r) => r.cells),
  ...(t.notes ?? []).map((x) => [x]),
];

/** RFC 4180 CSV (CRLF), UTF-8 BOM so Excel reads Indonesian text right. */
export function toCsv(t: ReportTable): string {
  return (
    '﻿' +
    tableRows(t)
      .map((r) => r.map(csvField).join(','))
      .join('\r\n') +
    '\r\n'
  );
}

// ---------------------------------------------------------------- XLSX

/** A money string as a JS number only when the double AND Excel (15
 *  significant digits) hold it exactly; otherwise the exact string. Amounts
 *  go up to 16 integer digits + 4 dp, which no double can carry. */
export function xlsxMoney(s: string): number | string {
  const digits = s
    .replace(/^-/, '')
    .replace(/(\.\d*?)0+$/, '$1')
    .replace('.', '')
    .replace(/^0+/, '');
  return digits.length <= 15 ? Number(s) : s;
}

const MONEY_FORMAT = '#,##0.00;(#,##0.00)';

export async function toXlsx(t: ReportTable): Promise<Buffer> {
  const wb = new Workbook();
  const headerRow = t.title.length + 2; // titles, blank, header
  const ws = wb.addWorksheet('Report', {
    views: [{ state: 'frozen', ySplit: headerRow }],
  });
  for (const x of t.title) ws.addRow([x]).font = { bold: true };
  ws.addRow([]);
  ws.addRow(t.header).font = { bold: true };
  for (const r of t.rows) {
    const row = ws.addRow(
      r.cells.map((c) => (typeof c === 'string' ? c : xlsxMoney(c.money))),
    );
    r.cells.forEach((c, i) => {
      if (typeof c !== 'string') {
        const cell = row.getCell(i + 1);
        cell.numFmt = MONEY_FORMAT;
        if (typeof cell.value === 'string')
          cell.alignment = { horizontal: 'right' };
      }
    });
    if (r.bold) row.font = { bold: true };
  }
  for (const x of t.notes ?? []) ws.addRow([x]).font = { italic: true };
  ws.columns.forEach((col, i) => {
    const longest = Math.max(
      t.header[i]?.length ?? 0,
      ...t.rows.map((r) => {
        const c = r.cells[i];
        return c === undefined
          ? 0
          : (typeof c === 'string' ? c : c.money).length;
      }),
    );
    col.width = Math.min(Math.max(longest + 2, 10), 60);
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** JSON as-is, or the rendered file as an attachment named `<name>.<ext>`
 *  (callers build `name` from validated dates only). */
export async function exportOr<T>(
  format: ExportFormat | undefined,
  report: T,
  toTable: (r: T) => ReportTable,
  name: string,
): Promise<T | StreamableFile> {
  if (!format) return report;
  const table = toTable(report);
  const body =
    format === 'csv' ? Buffer.from(toCsv(table), 'utf8') : await toXlsx(table);
  return new StreamableFile(body, {
    type: format === 'csv' ? CSV_TYPE : XLSX_TYPE,
    disposition: `attachment; filename="${name}.${format}"`,
    length: body.length,
  });
}
