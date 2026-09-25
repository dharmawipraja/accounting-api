import { ValidationFailedError } from '../../common/errors/domain-errors';

/** The account attributes the CASH role rule looks at. `id` is absent on
 *  create (the account does not exist yet). */
export interface CashCandidate {
  id?: string;
  type: string;
  normalBalance: string;
  isPostable: boolean;
  role: string | null;
}

/**
 * The single CASH-role shape rule, shared by account create (`role: 'CASH'`)
 * and PATCH (`role: 'CASH'` on an existing account): CASH may only sit on a
 * postable, debit-normal ASSET, and never replaces a singleton system role.
 * An account already holding CASH passes (idempotent re-assign). Pure — the
 * caller supplies the row (read under its own lock for PATCH). 422 otherwise.
 */
export function assertCashAssignable(a: CashCandidate): void {
  if (a.role === 'CASH') return;
  if (a.role !== null)
    throw new ValidationFailedError(
      `Account already holds the system role ${a.role}; system roles cannot be changed`,
      { id: a.id, role: a.role },
    );
  if (a.type !== 'ASSET' || a.normalBalance !== 'DEBIT' || !a.isPostable)
    throw new ValidationFailedError(
      'The CASH role requires a postable, debit-normal ASSET account',
      {
        id: a.id,
        type: a.type,
        normalBalance: a.normalBalance,
        isPostable: a.isPostable,
      },
    );
}
