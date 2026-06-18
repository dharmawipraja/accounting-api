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
