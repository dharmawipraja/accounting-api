import { AccountRole, Prisma } from '@prisma/client';
import { Money } from '../common/money/money';
import { PrismaService } from '../common/prisma/prisma.service';
import { ValidationFailedError } from '../common/errors/domain-errors';
import type { TaxCalculation } from '../tax/tax.service';
import { nextSequenceNumber, SqlTx } from '../common/db/sequence';
import { buildDocRef } from '../common/db/doc-ref';
import { assertNotAfterToday } from '../common/dates/not-after-today';

type DecimalLike = Prisma.Decimal | string;

/** A line's discount as entered: a percent OR a fixed amount (the DTO makes
 *  them mutually exclusive). A stored row carries both — the entered percent
 *  and its resolved amount — so a non-null percent wins. */
export type DiscountedLineInput = {
  quantity: DecimalLike;
  unitPrice: DecimalLike;
  discountPercent?: DecimalLike | null;
  discountAmount?: DecimalLike | null;
};

type TaxableLineInput = DiscountedLineInput & {
  accountId: string;
  taxCodeIds: string[];
};

/** Pure: resolve one line's discount and NET amount (the DPP).
 *  gross = qty × unitPrice (4dp half-up, as before discounts);
 *  percent discount = gross × percent / 100, computed exactly then rounded
 *  ONCE to 4dp half-up; amount = gross − discount. 422 when the discount
 *  exceeds the gross (a negative line). `lineNo` (1-based) is for the error. */
export function lineAmounts(
  l: DiscountedLineInput,
  lineNo?: number,
): { discountPercent: string | null; discountAmount: string; amount: string } {
  const gross = Money.of(l.unitPrice.toString()).multiply(
    l.quantity.toString(),
  );
  const pct = l.discountPercent == null ? null : l.discountPercent.toString();
  const discount =
    pct !== null
      ? gross.multiply(new Prisma.Decimal(pct).div(100))
      : Money.of(l.discountAmount?.toString() ?? '0');
  if (discount.isNegative() || discount.greaterThan(gross))
    throw new ValidationFailedError(
      'Line discount cannot exceed quantity × unit price',
      {
        ...(lineNo === undefined ? {} : { lineNo }),
        gross: gross.toPersistence(),
        discountAmount: discount.toPersistence(),
      },
    );
  return {
    discountPercent: pct,
    discountAmount: discount.toPersistence(),
    amount: gross.subtract(discount).toPersistence(),
  };
}

/** Sum of the lines' resolved discounts (the document's discountTotal). */
export function discountTotal(lines: DiscountedLineInput[]): string {
  return Money.sum(
    lines.map((l, i) => Money.of(lineAmounts(l, i + 1).discountAmount)),
  ).toPersistence();
}

/** Maps document lines to the tax engine's taxable-line shape: amount = the
 *  NET line amount (qty × unitPrice − discount, 4dp), so tax is on the DPP. */
export function taxableLines(lines: TaxableLineInput[]) {
  return lines.map((l, i) => ({
    accountId: l.accountId,
    amount: lineAmounts(l, i + 1).amount,
    taxCodeIds: l.taxCodeIds,
  }));
}

/** Resolves a control account's id by its role; 422 if it is missing. */
export async function findControlAccountId(
  prisma: PrismaService,
  role: AccountRole,
): Promise<string> {
  const acc = await prisma.client.account.findFirst({ where: { role } });
  if (!acc) {
    throw new ValidationFailedError('Control account missing from chart', {
      role,
    });
  }
  return acc.id;
}

/** A void (reversal) may be dated later than the document/payment it voids,
 *  never earlier. Both dates are UTC-midnight @db.Date values. */
export function assertVoidDateNotBefore(
  voidedOn: Date,
  documentDate: Date,
  id: string,
): void {
  if (voidedOn.getTime() < documentDate.getTime()) {
    throw new ValidationFailedError(
      'Void date cannot be before the document date',
      {
        id,
        date: voidedOn.toISOString().slice(0, 10),
        documentDate: documentDate.toISOString().slice(0, 10),
      },
    );
  }
}

/** The pre-tx rules every void (document, note, payment) shares; returns the
 *  void date. 422 `onlyPostedMessage` unless POSTED. The void (reversal) date
 *  defaults to the row's own date; a later date lets it be voided after its
 *  own period has closed. An explicit void date may not be after max(today
 *  (WIB), own date) — 422 { date, today[, originalDate] }: a future-dated
 *  original may be voided on its own date, like the no-body void — nor
 *  before its own date (assertVoidDateNotBefore). */
export function resolveVoidDate(
  row: { id: string; status: string; date: Date },
  date: Date | undefined,
  onlyPostedMessage: string,
): Date {
  if (row.status !== 'POSTED')
    throw new ValidationFailedError(onlyPostedMessage, {
      id: row.id,
      status: row.status,
    });
  const voidedOn = date ?? row.date;
  if (date)
    assertNotAfterToday(date, 'Void date cannot be in the future', {
      originalDate: row.date,
    });
  assertVoidDateNotBefore(voidedOn, row.date, row.id);
  return voidedOn;
}

/** A document's due date may equal its date but never precede it. Both are
 *  UTC-midnight business dates; an absent due date is always fine. */
export function assertDueDateNotBefore(
  date: Date,
  dueDate: Date | null | undefined,
): void {
  if (dueDate && dueDate.getTime() < date.getTime()) {
    throw new ValidationFailedError(
      'Due date cannot be before the document date',
      {
        date: date.toISOString().slice(0, 10),
        dueDate: dueDate.toISOString().slice(0, 10),
      },
    );
  }
}

type PostableLine = TaxableLineInput;

/** The document content a journal entry is derived from. */
export interface PostableDraftContent {
  date: Date;
  description: string | null;
  lines?: PostableLine[];
}

/** True when two reads of a draft carry the same postable content (date,
 *  description, and lines in order: account, quantity, unit price, discount
 *  percent/amount, tax codes).
 *  Posting uses it under the document row lock to prove the entry it prepared
 *  from a pre-lock read matches the locked row. */
export function samePostableContent(
  a: PostableDraftContent,
  b: PostableDraftContent,
): boolean {
  if (a.date.getTime() !== b.date.getTime()) return false;
  if ((a.description ?? null) !== (b.description ?? null)) return false;
  const la = a.lines ?? [];
  const lb = b.lines ?? [];
  if (la.length !== lb.length) return false;
  const eq = (x: DecimalLike, y: DecimalLike) =>
    new Prisma.Decimal(x.toString()).equals(y.toString());
  // Absent and null mean "none": no percent, a zero amount.
  const eqOpt = (
    x: DecimalLike | null | undefined,
    y: DecimalLike | null | undefined,
    none: DecimalLike | null,
  ) => {
    const a = x ?? none;
    const b = y ?? none;
    return a === null || b === null ? a === b : eq(a, b);
  };
  return la.every((x, i) => {
    const y = lb[i];
    return (
      x.accountId === y.accountId &&
      eq(x.quantity, y.quantity) &&
      eq(x.unitPrice, y.unitPrice) &&
      eqOpt(x.discountPercent, y.discountPercent, null) &&
      eqOpt(x.discountAmount, y.discountAmount, '0') &&
      x.taxCodeIds.length === y.taxCodeIds.length &&
      x.taxCodeIds.every((t, j) => t === y.taxCodeIds[j])
    );
  });
}

/** Normalize a vendor invoice number for storage: trimmed; a blank value or an
 *  explicit `null` clears it (null); `undefined` (omitted) stays undefined.
 *  Uniqueness is enforced case-insensitively on the trimmed value by the
 *  `(partner_id, lower(btrim(vendor_invoice_no)))` partial unique index. */
export function normalizeVendorInvoiceNo(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Pure: do two tax calculations yield the same document totals, tax
 *  breakdown and journal lines? Document post re-runs the calculation inside
 *  its tx (after the row lock) and restarts when this is false — a tax-code
 *  rate/account change committed between the pre-tx calculation and the lock. */
export function sameTaxCalculation(
  a: TaxCalculation,
  b: TaxCalculation,
): boolean {
  const amt = (x: string | undefined, y: string | undefined) =>
    Money.of(x ?? '0').equals(Money.of(y ?? '0'));
  if (
    !amt(a.subtotal, b.subtotal) ||
    !amt(a.taxTotal, b.taxTotal) ||
    !amt(a.withholdingTotal, b.withholdingTotal) ||
    !amt(a.settlementAmount, b.settlementAmount) ||
    a.taxes.length !== b.taxes.length ||
    a.journalLines.length !== b.journalLines.length
  )
    return false;
  const taxesMatch = a.taxes.every((t, i) => {
    const u = b.taxes[i];
    return (
      t.taxCodeId === u.taxCodeId &&
      t.kind === u.kind &&
      t.accountId === u.accountId &&
      amt(t.base, u.base) &&
      amt(t.amount, u.amount)
    );
  });
  return (
    taxesMatch &&
    a.journalLines.every((l, i) => {
      const m = b.journalLines[i];
      return (
        l.accountId === m.accountId &&
        amt(l.debit, m.debit) &&
        amt(l.credit, m.credit)
      );
    })
  );
}

/** Lock-and-increment the per-(type, fiscal-year) document counter inside the
 *  caller's transaction (gapless: the increment and the document write share
 *  the tx) and build its ref, e.g. INV/2026/000042. */
export async function nextDocumentNumber(
  tx: SqlTx,
  documentType: string,
  fiscalYear: number,
): Promise<{ number: number; ref: string }> {
  const number = await nextSequenceNumber(tx, 'document_sequences', {
    document_type: documentType,
    fiscal_year: fiscalYear,
  });
  return { number, ref: buildDocRef(documentType, fiscalYear, number) };
}
