import { AccountRole, AccountSubtype, AccountType } from '@prisma/client';
import { ValidationFailedError } from '../common/errors/domain-errors';
import { LedgerTx } from '../ledger/posting/posting.service';

/** Account fields the document account rules look at. */
export interface RuleAccount {
  id: string;
  role: AccountRole | null;
  type: AccountType;
  subtype: AccountSubtype;
}

export interface AccountRuleViolation {
  message: string;
  details:
    | { accountId: string; role: AccountRole | null }
    | { accountId: string; reason: 'TAX_ACCOUNT' | 'ACCOUNT_TYPE' };
}

/** System-managed roles a document line may never post to: the control account
 *  is the document's own settlement side, and cash moves only via payments. */
const LINE_FORBIDDEN_ROLES: readonly AccountRole[] = [
  'AR_CONTROL',
  'AP_CONTROL',
  'CASH',
];

/** Pure rule for an invoice/bill line account. Order: forbidden role, then tax
 *  account (tax postings come from tax codes), then the nature's type rule
 *  (sales → REVENUE type or OTHER_INCOME subtype; purchase → EXPENSE or ASSET,
 *  i.e. expenses, inventory, fixed assets). */
export function documentLineAccountViolation(
  nature: 'SALE' | 'PURCHASE',
  account: RuleAccount,
  isTaxAccount: boolean,
): AccountRuleViolation | null {
  if (account.role && LINE_FORBIDDEN_ROLES.includes(account.role)) {
    return {
      message:
        account.role === 'CASH'
          ? 'Document lines cannot post to a cash account; record cash movements as payments'
          : 'Document lines cannot post to an AR/AP control account; the document settles it',
      details: { accountId: account.id, role: account.role },
    };
  }
  if (isTaxAccount) {
    return {
      message:
        'Document lines cannot post to a tax account; apply a tax code instead',
      details: { accountId: account.id, reason: 'TAX_ACCOUNT' },
    };
  }
  const typeOk =
    nature === 'SALE'
      ? account.type === 'REVENUE' || account.subtype === 'OTHER_INCOME'
      : account.type === 'EXPENSE' || account.type === 'ASSET';
  if (!typeOk) {
    return {
      message:
        nature === 'SALE'
          ? 'Sales invoice lines must use a revenue account'
          : 'Purchase bill lines must use an expense or asset account',
      details: { accountId: account.id, reason: 'ACCOUNT_TYPE' },
    };
  }
  return null;
}

/** Pure rule for a payment's cash account: it must carry the CASH role. */
export function cashAccountViolation(account: {
  id: string;
  role: AccountRole | null;
}): AccountRuleViolation | null {
  if (account.role === 'CASH') return null;
  return {
    message: 'Payment cash account must be a CASH-role (cash/bank) account',
    details: { accountId: account.id, role: account.role },
  };
}

function throwIf(v: AccountRuleViolation | null): void {
  if (v) throw new ValidationFailedError(v.message, v.details);
}

/** Assert every invoice/bill line account satisfies documentLineAccountViolation
 *  (422 VALIDATION_FAILED on the first offending line). Accounts that do not
 *  exist are skipped here — the postable-account check reports those. Runs on
 *  the base client (create/update/preview) or inside the post transaction. */
export async function assertDocumentLineAccounts(
  db: LedgerTx,
  nature: 'SALE' | 'PURCHASE',
  accountIds: string[],
): Promise<void> {
  const unique = [...new Set(accountIds)];
  if (unique.length === 0) return;
  const [accounts, taxCodes] = await Promise.all([
    db.account.findMany({
      where: { id: { in: unique } },
      select: { id: true, role: true, type: true, subtype: true },
    }),
    db.taxCode.findMany({
      where: { taxAccountId: { in: unique } },
      select: { taxAccountId: true },
    }),
  ]);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const taxAccountIds = new Set(taxCodes.map((t) => t.taxAccountId));
  for (const id of unique) {
    const a = byId.get(id);
    if (a)
      throwIf(documentLineAccountViolation(nature, a, taxAccountIds.has(id)));
  }
}

/** Assert a payment's cash account carries the CASH role (422 otherwise).
 *  A missing account is skipped — the postable-account check reports it. */
export async function assertCashAccount(
  db: LedgerTx,
  cashAccountId: string,
): Promise<void> {
  const a = await db.account.findFirst({
    where: { id: cashAccountId },
    select: { id: true, role: true },
  });
  if (a) throwIf(cashAccountViolation(a));
}
