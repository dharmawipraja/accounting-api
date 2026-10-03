import { AccountRole, Prisma } from '@prisma/client';
import { Money } from '../common/money/money';
import { PrismaService } from '../common/prisma/prisma.service';
import { ValidationFailedError } from '../common/errors/domain-errors';
import type { TaxCalculation } from '../tax/tax.service';

type TaxableLineInput = {
  accountId: string;
  quantity: Prisma.Decimal | string;
  unitPrice: Prisma.Decimal | string;
  taxCodeIds: string[];
};

/** Maps document lines to the tax engine's taxable-line shape (amount = qty*unitPrice, 4dp). */
export function taxableLines(lines: TaxableLineInput[]) {
  return lines.map((l) => ({
    accountId: l.accountId,
    amount: Money.of(l.unitPrice.toString())
      .multiply(l.quantity.toString())
      .toPersistence(),
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

type PostableLine = {
  accountId: string;
  quantity: Prisma.Decimal | string;
  unitPrice: Prisma.Decimal | string;
  taxCodeIds: string[];
};

/** The document content a journal entry is derived from. */
export interface PostableDraftContent {
  date: Date;
  description: string | null;
  lines?: PostableLine[];
}

/** True when two reads of a draft carry the same postable content (date,
 *  description, and lines in order: account, quantity, unit price, tax codes).
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
  const eq = (x: Prisma.Decimal | string, y: Prisma.Decimal | string) =>
    new Prisma.Decimal(x.toString()).equals(y.toString());
  return la.every((x, i) => {
    const y = lb[i];
    return (
      x.accountId === y.accountId &&
      eq(x.quantity, y.quantity) &&
      eq(x.unitPrice, y.unitPrice) &&
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
