import { strFromU8, unzipSync } from 'fflate';

/** Test-only reader for the single-sheet XLSX files src/reporting/export
 *  writes (write-excel-file output): cell values by row, plus the bits of
 *  styling the tests assert. Not a general XLSX parser. */
export interface XlsxCell {
  value: string | number;
  isString: boolean;
  bold: boolean;
  numFmt?: string;
  alignRight: boolean;
}

export interface XlsxSheet {
  frozenRows: number;
  /** 1-based like Excel: cell('B4'). */
  cell: (ref: string) => XlsxCell | undefined;
  /** Every row as text (numbers stringified), '' for empty cells. */
  rows: string[][];
}

const unescape = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const colIndex = (letters: string) =>
  [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

export function readXlsx(buf: Buffer): XlsxSheet {
  const z = unzipSync(new Uint8Array(buf));
  const xml = (name: string) => (z[name] ? strFromU8(z[name]) : '');
  const shared = [
    ...xml('xl/sharedStrings.xml').matchAll(/<si>(.*?)<\/si>/gs),
  ].map((m) =>
    unescape(
      [...m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((t) => t[1]).join(''),
    ),
  );
  const styles = xml('xl/styles.xml');
  const numFmts = new Map(
    [...styles.matchAll(/<numFmt numFmtId="(\d+)" formatCode="([^"]*)"/g)].map(
      (m) => [m[1], unescape(m[2])],
    ),
  );
  const fonts = [...styles.matchAll(/<font>(.*?)<\/font>/gs)].map((m) =>
    m[1].includes('<b/>'),
  );
  const xfBlock = /<cellXfs[^>]*>(.*?)<\/cellXfs>/s.exec(styles)?.[1] ?? '';
  const xfs = [
    ...xfBlock.matchAll(/<xf([^>]*)>(.*?)<\/xf>|<xf([^>]*)\/>/gs),
  ].map((m) => {
    const attrs = m[1] ?? m[3] ?? '';
    const font = /fontId="(\d+)"/.exec(attrs)?.[1];
    const fmt = /numFmtId="(\d+)"/.exec(attrs)?.[1];
    return {
      bold: font !== undefined && fonts[Number(font)] === true,
      numFmt: fmt ? numFmts.get(fmt) : undefined,
      alignRight: (m[2] ?? '').includes('horizontal="right"'),
    };
  });
  const sheet = xml('xl/worksheets/sheet1.xml');
  const cells = new Map<string, XlsxCell>();
  for (const m of sheet.matchAll(
    /<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs,
  )) {
    const attrs = m[2];
    const raw = /<v>(.*?)<\/v>/s.exec(m[3] ?? '')?.[1] ?? '';
    const inline = /<is>.*?<t[^>]*>(.*?)<\/t>/s.exec(m[3] ?? '')?.[1];
    const type = /t="(\w+)"/.exec(attrs)?.[1];
    const xf = xfs[Number(/s="(\d+)"/.exec(attrs)?.[1] ?? 0)] ?? {
      bold: false,
      alignRight: false,
    };
    const isString = type === 's' || type === 'inlineStr' || type === 'str';
    const value =
      type === 's'
        ? shared[Number(raw)]
        : inline !== undefined
          ? unescape(inline)
          : isString
            ? unescape(raw)
            : Number(raw);
    cells.set(m[1], { value, isString, ...xf });
  }
  const frozenRows = Number(/<pane[^>]*ySplit="(\d+)"/.exec(sheet)?.[1] ?? 0);
  const rowCount = Math.max(
    0,
    ...[...sheet.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1])),
  );
  let colCount = 0;
  for (const ref of cells.keys())
    colCount = Math.max(colCount, colIndex(/^[A-Z]+/.exec(ref)![0]) + 1);
  const rows: string[][] = [];
  for (let r = 1; r <= rowCount; r++)
    rows.push(
      Array.from({ length: colCount }, (_, c) => {
        const ref = String.fromCharCode(65 + c) + r;
        const v = cells.get(ref)?.value;
        return v === undefined ? '' : String(v);
      }),
    );
  return { frozenRows, cell: (ref) => cells.get(ref), rows };
}
