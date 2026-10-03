import type { AccountRole } from '@prisma/client';
import { ValidationFailedError } from '../../common/errors/domain-errors';

/** The account shape each system role requires (matches the seed chart):
 *  every role-held account is postable; the type/normal side follow what
 *  the posting code books to it. */
export const ROLE_SHAPES: Record<
  AccountRole,
  { type: string; normalBalance: string }
> = {
  CASH: { type: 'ASSET', normalBalance: 'DEBIT' },
  AR_CONTROL: { type: 'ASSET', normalBalance: 'DEBIT' },
  VENDOR_ADVANCE: { type: 'ASSET', normalBalance: 'DEBIT' },
  AP_CONTROL: { type: 'LIABILITY', normalBalance: 'CREDIT' },
  CUSTOMER_ADVANCE: { type: 'LIABILITY', normalBalance: 'CREDIT' },
  RETAINED_EARNINGS: { type: 'EQUITY', normalBalance: 'CREDIT' },
  OPENING_BALANCE_EQUITY: { type: 'EQUITY', normalBalance: 'CREDIT' },
  TAX_EXPENSE: { type: 'EXPENSE', normalBalance: 'DEBIT' },
};

/** 422 unless the account has the shape `role` requires (postable, plus the
 *  ROLE_SHAPES type + normal balance). Pure. */
export function assertRoleShape(
  role: AccountRole,
  a: { id?: string; type: string; normalBalance: string; isPostable: boolean },
): void {
  const want = ROLE_SHAPES[role];
  if (
    a.type !== want.type ||
    a.normalBalance !== want.normalBalance ||
    !a.isPostable
  )
    throw new ValidationFailedError(
      `The ${role} role requires a postable, ${want.normalBalance.toLowerCase()}-normal ${want.type} account`,
      {
        id: a.id,
        role,
        required: { ...want, isPostable: true },
        type: a.type,
        normalBalance: a.normalBalance,
        isPostable: a.isPostable,
      },
    );
}

/** The account attributes the CASH role rule looks at. `id` is absent on
 *  create (the account does not exist yet). */
export interface CashCandidate {
  id?: string;
  type: string;
  normalBalance: string;
  isPostable: boolean;
  role: string | null;
  /** True when ANY tax code (live or soft-deleted) posts to this account —
   *  the caller looks it up (the rule itself stays pure). A tax account is
   *  never a cash account (its balance is a tax position, not cash). */
  usedByTaxCode?: boolean;
}

/**
 * The single CASH-role shape rule, shared by account create (`role: 'CASH'`)
 * and PATCH (`role: 'CASH'` on an existing account): CASH may only sit on a
 * postable, debit-normal ASSET, never replaces a singleton system role, and
 * never lands on an account a tax code posts to (incl. soft-deleted codes,
 * whose posted history still sits on it).
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
  if (a.usedByTaxCode)
    throw new ValidationFailedError(
      'The CASH role cannot be assigned to a tax account (an account used by a tax code)',
      { id: a.id, reason: 'TAX_ACCOUNT' },
    );
  assertRoleShape('CASH', a);
}
