import {
  AccountRole,
  AccountSubtype,
  AccountType,
  NormalBalance,
  Prisma,
  TaxKind,
} from '@prisma/client';
import { ValidationFailedError } from '../common/errors/domain-errors';
import { LedgerTx } from '../ledger/posting/posting.service';
import { taxAccountViolation } from '../tax/tax-account-rule';

/** Account fields the document account rules look at. */
export interface RuleAccount {
  id: string;
  role: AccountRole | null;
  type: AccountType;
  subtype: AccountSubtype;
  normalBalance: NormalBalance;
}

export interface AccountRuleViolation {
  message: string;
  details:
    | { accountId: string; role: AccountRole | null }
    | {
        accountId: string;
        reason:
          | 'TAX_ACCOUNT'
          | 'ACCOUNT_TYPE'
          | 'CONTRA_ASSET'
          | 'CONTRA_REVENUE'
          | 'CONTRA_EXPENSE';
      };
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
 *  i.e. expenses, inventory, fixed assets — but never a contra-asset, an ASSET
 *  with a CREDIT normal balance such as Akumulasi Penyusutan, which only moves
 *  via depreciation/disposal journals; sales → never a contra-revenue, a
 *  REVENUE with a DEBIT normal balance such as Retur/Potongan Penjualan —
 *  returns belong to credit notes, not negative-meaning invoice lines;
 *  purchase → never a contra-expense, an EXPENSE with a CREDIT normal balance
 *  such as Potongan/Retur Pembelian — purchase returns/discounts belong to
 *  debit notes, a feature backlog item). */
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
  if (
    nature === 'PURCHASE' &&
    account.type === 'ASSET' &&
    account.normalBalance === 'CREDIT'
  ) {
    return {
      message:
        'Purchase bill lines cannot post to a contra-asset account (e.g. accumulated depreciation)',
      details: { accountId: account.id, reason: 'CONTRA_ASSET' },
    };
  }
  if (
    nature === 'PURCHASE' &&
    account.type === 'EXPENSE' &&
    account.normalBalance === 'CREDIT'
  ) {
    return {
      message:
        'Purchase bill lines cannot post to a contra-expense account (e.g. purchase returns/discounts)',
      details: { accountId: account.id, reason: 'CONTRA_EXPENSE' },
    };
  }
  if (
    nature === 'SALE' &&
    account.type === 'REVENUE' &&
    account.normalBalance === 'DEBIT'
  ) {
    return {
      message:
        'Sales invoice lines cannot post to a contra-revenue account (e.g. sales returns/discounts)',
      details: { accountId: account.id, reason: 'CONTRA_REVENUE' },
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
      select: {
        id: true,
        role: true,
        type: true,
        subtype: true,
        normalBalance: true,
      },
    }),
    // Raw on purpose: a soft-deleted tax code still marks its account as a
    // tax account (the soft-delete extension would hide it).
    db.$queryRaw<{ tax_account_id: string }[]>`
      SELECT DISTINCT tax_account_id FROM tax_codes
      WHERE tax_account_id IN (${Prisma.join(unique)})`,
  ]);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const taxAccountIds = new Set(taxCodes.map((t) => t.tax_account_id));
  for (const id of unique) {
    const a = byId.get(id);
    if (a)
      throwIf(documentLineAccountViolation(nature, a, taxAccountIds.has(id)));
  }
}

/** Re-validate, inside the document post tx, the accounts the computed tax
 *  lines post to against the tax-account rule (a tax code's account may have
 *  been re-shaped since the code was created). 422 on the first violation.
 *  A missing account is skipped — the postable-account check reports it. */
export async function assertTaxLineAccounts(
  db: LedgerTx,
  taxes: { kind: TaxKind; accountId: string }[],
): Promise<void> {
  if (taxes.length === 0) return;
  // Plain (unlocked) read on purpose: the attributes checked here — subtype,
  // normal balance, postable, role — are either immutable after create or
  // only changed via paths that refuse tax accounts (PATCH role:'CASH' is
  // rejected for an account used by any tax code). The postable/active/live
  // check that DOES race (deactivate, soft-delete) is re-done under FOR SHARE
  // by PostingService's in-tx account check for every journal line.
  const accounts = await db.account.findMany({
    where: { id: { in: [...new Set(taxes.map((t) => t.accountId))] } },
    select: {
      id: true,
      role: true,
      subtype: true,
      normalBalance: true,
      isPostable: true,
    },
  });
  const byId = new Map(accounts.map((a) => [a.id, a]));
  for (const t of taxes) {
    const a = byId.get(t.accountId);
    if (!a) continue;
    const v = taxAccountViolation(t.kind, a);
    if (v) throw new ValidationFailedError(v.message, v.details);
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
