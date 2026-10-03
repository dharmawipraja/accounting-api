import { AccountRole, AccountType, JournalSourceType } from '@prisma/client';

/** Which system-account roles (and account types) a journal entry of a given
 *  source type may NOT touch. Pure data + pure check — the DB reads live in
 *  PostingService. */
export interface AccountPolicy {
  readonly forbiddenRoles: readonly AccountRole[];
  /** Account types the source type may not post to; a hit is a 422
   *  `{ accountId, reason }` with this policy's reason/message. */
  readonly forbiddenTypes?: {
    readonly types: readonly AccountType[];
    readonly reason: string;
    readonly message: string;
  };
  /** Skip the isActive check (exists / postable / not-deleted still apply).
   *  Only CLOSING: a P&L account deactivated mid-year still carries FY movement
   *  the year-end close must zero into Laba Ditahan. */
  readonly allowInactive?: boolean;
}

/** AR/AP control balances must only move through documents (invoice, bill,
 *  credit/debit note, payment) so the subledger stays equal to the control
 *  account. A MANUAL entry on a control account would drift the two apart.
 *  Likewise the advance accounts (Uang Muka Pelanggan / Pembelian) must equal
 *  the posted payments' + notes' unapplied amounts, so only payments,
 *  credit/debit notes (their excess) and their applications move them. The
 *  note source types fall through to the unrestricted policy like invoices
 *  and bills. OPENING (go-live), CLOSING,
 *  REVERSAL and the document source types are deliberately role-unrestricted. */
export const MANUAL_ENTRY_POLICY: AccountPolicy = {
  forbiddenRoles: [
    'AR_CONTROL',
    'AP_CONTROL',
    'CUSTOMER_ADVANCE',
    'VENDOR_ADVANCE',
  ],
};

export const UNRESTRICTED_POLICY: AccountPolicy = { forbiddenRoles: [] };

/** Opening balances are balance-sheet positions only: a REVENUE/EXPENSE
 *  account is a 422 `PNL_IN_OPENING` (mid-year YTD P&L goes in as a MANUAL
 *  journal). Role-unrestricted — go-live may seed AR/AP control, but only
 *  before the first document and only as the one live opening entry (both
 *  checked in-tx by PostingService.assertOpeningAllowedInTx). Enforced by
 *  PostingService for every OPENING post, not only the endpoint. Account type
 *  is immutable, so the pre-tx check cannot go stale. */
export const OPENING_POLICY: AccountPolicy = {
  forbiddenRoles: [],
  forbiddenTypes: {
    types: ['REVENUE', 'EXPENSE'],
    reason: 'PNL_IN_OPENING',
    message:
      'Opening balances may only use balance-sheet accounts; enter year-to-date revenue/expense as a MANUAL journal',
  },
};

/** Year-end close: role-unrestricted AND tolerant of inactive accounts (see
 *  AccountPolicy.allowInactive). Every other source type keeps isActive. */
export const CLOSING_POLICY: AccountPolicy = {
  forbiddenRoles: [],
  allowInactive: true,
};

export function accountPolicyFor(sourceType: JournalSourceType): AccountPolicy {
  if (sourceType === 'MANUAL') return MANUAL_ENTRY_POLICY;
  if (sourceType === 'CLOSING') return CLOSING_POLICY;
  if (sourceType === 'OPENING') return OPENING_POLICY;
  return UNRESTRICTED_POLICY;
}

/** The first account (in the given order) whose role the policy forbids, or null. */
export function findForbiddenRole(
  accounts: readonly { id: string; role: AccountRole | null }[],
  policy: AccountPolicy,
): { accountId: string; role: AccountRole } | null {
  for (const a of accounts) {
    if (a.role && policy.forbiddenRoles.includes(a.role))
      return { accountId: a.id, role: a.role };
  }
  return null;
}

/** The first account (in the given order) whose type the policy forbids, as
 *  the 422 details `{ accountId, reason }`, or null. */
export function findForbiddenType(
  accounts: readonly { id: string; type: AccountType }[],
  policy: AccountPolicy,
): { accountId: string; reason: string } | null {
  const rule = policy.forbiddenTypes;
  if (!rule) return null;
  for (const a of accounts) {
    if (rule.types.includes(a.type))
      return { accountId: a.id, reason: rule.reason };
  }
  return null;
}

export const FORBIDDEN_ROLE_MESSAGE =
  'AR/AP control and payment advance accounts can only be posted through sales invoices, purchase bills and payments';
