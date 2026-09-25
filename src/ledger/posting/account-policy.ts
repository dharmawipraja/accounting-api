import { AccountRole, JournalSourceType } from '@prisma/client';

/** Which system-account roles a journal entry of a given source type may NOT
 *  touch. Pure data + pure check — the DB reads live in PostingService. */
export interface AccountPolicy {
  readonly forbiddenRoles: readonly AccountRole[];
}

/** AR/AP control balances must only move through documents (invoice, bill,
 *  payment) so the subledger stays equal to the control account. A MANUAL entry
 *  on a control account would drift the two apart. OPENING (go-live), CLOSING,
 *  REVERSAL and the document source types are deliberately unrestricted. */
export const MANUAL_ENTRY_POLICY: AccountPolicy = {
  forbiddenRoles: ['AR_CONTROL', 'AP_CONTROL'],
};

export const UNRESTRICTED_POLICY: AccountPolicy = { forbiddenRoles: [] };

export function accountPolicyFor(sourceType: JournalSourceType): AccountPolicy {
  return sourceType === 'MANUAL' ? MANUAL_ENTRY_POLICY : UNRESTRICTED_POLICY;
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
