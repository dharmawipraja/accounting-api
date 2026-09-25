import { AccountRole, Prisma } from '@prisma/client';
import { Money } from '../common/money/money';
import { PrismaService } from '../common/prisma/prisma.service';
import { ValidationFailedError } from '../common/errors/domain-errors';

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
