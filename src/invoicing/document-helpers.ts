import { Prisma } from '@prisma/client';
import { Money } from '../common/money/money';
import { PrismaService } from '../common/prisma/prisma.service';
import { ValidationFailedError } from '../common/errors/domain-errors';

/** AR control account code in the chart of accounts. */
export const AR_CONTROL_CODE = '1-1200';
/** AP control account code in the chart of accounts. */
export const AP_CONTROL_CODE = '2-1000';

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

/** Resolves a control account's id by chart code; 422 if it is missing. */
export async function findControlAccountId(
  prisma: PrismaService,
  code: string,
): Promise<string> {
  const acc = await prisma.client.account.findFirst({ where: { code } });
  if (!acc) {
    throw new ValidationFailedError('Control account missing from chart', {
      code,
    });
  }
  return acc.id;
}
