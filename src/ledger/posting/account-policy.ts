import { AccountRole, JournalSourceType } from '@prisma/client';

/** Which system-account roles a journal entry of a given source type may NOT
 *  touch. Pure data + pure check — the DB reads live in PostingService. */
export interface AccountPolicy {
  readonly forbiddenRoles: readonly AccountRole[];
  /** Skip the isActive check (exists / postable / not-deleted still apply).
   *  Only CLOSING: a P&L account deactivated mid-year still carries FY movement
   *  the year-end close must zero into Laba Ditahan. */
  readonly allowInactive?: boolean;
}

/** AR/AP control balances must only move through documents (invoice, bill,
 *  payment) so the subledger stays equal to the control account. A MANUAL entry
 *  on a control account would drift the two apart. OPENING (go-live), CLOSING,
 *  REVERSAL and the document source types are deliberately unrestricted. */
export const MANUAL_ENTRY_POLICY: AccountPolicy = {
  forbiddenRoles: ['AR_CONTROL', 'AP_CONTROL'],
};

export const UNRESTRICTED_POLICY: AccountPolicy = { forbiddenRoles: [] };

/** Year-end close: role-unrestricted AND tolerant of inactive accounts (see
 *  AccountPolicy.allowInactive). Every other source type keeps isActive. */
export const CLOSING_POLICY: AccountPolicy = {
  forbiddenRoles: [],
  allowInactive: true,
};

export function accountPolicyFor(sourceType: JournalSourceType): AccountPolicy {
  if (sourceType === 'MANUAL') return MANUAL_ENTRY_POLICY;
  if (sourceType === 'CLOSING') return CLOSING_POLICY;
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

export const FORBIDDEN_ROLE_MESSAGE =
  'AR/AP control accounts can only be posted through sales invoices, purchase bills and payments';
