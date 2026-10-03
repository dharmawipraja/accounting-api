import {
  CLOSING_POLICY,
  MANUAL_ENTRY_POLICY,
  NOTE_POLICY,
  UNRESTRICTED_POLICY,
  OPENING_POLICY,
  accountPolicyFor,
  findForbiddenRole,
  findForbiddenType,
} from './account-policy';

describe('account-policy', () => {
  it('restricts only MANUAL entries (AR/AP control forbidden)', () => {
    expect(accountPolicyFor('MANUAL')).toBe(MANUAL_ENTRY_POLICY);
    for (const t of [
      'REVERSAL',
      'SALES_INVOICE',
      'PURCHASE_BILL',
      'PAYMENT',
    ] as const) {
      expect(accountPolicyFor(t)).toBe(UNRESTRICTED_POLICY);
    }
    for (const t of ['SALES_CREDIT_NOTE', 'PURCHASE_DEBIT_NOTE'] as const)
      expect(accountPolicyFor(t).forbiddenRoles).toEqual([]);
    // OPENING: only the advance roles (a lump sum there has no per-partner
    // credit to apply or refund) — AR/AP control stays allowed at go-live.
    expect(accountPolicyFor('OPENING').forbiddenRoles).toEqual([
      'CUSTOMER_ADVANCE',
      'VENDOR_ADVANCE',
    ]);
  });

  it('OPENING refuses the advance roles with its own reason, allows AR/AP control', () => {
    expect(
      findForbiddenRole(
        [
          { id: 'ar', role: 'AR_CONTROL' },
          { id: 'ap', role: 'AP_CONTROL' },
          { id: 'eq', role: 'OPENING_BALANCE_EQUITY' },
        ],
        OPENING_POLICY,
      ),
    ).toBeNull();
    for (const role of ['CUSTOMER_ADVANCE', 'VENDOR_ADVANCE'] as const)
      expect(findForbiddenRole([{ id: 'adv', role }], OPENING_POLICY)).toEqual({
        accountId: 'adv',
        role,
      });
    expect(OPENING_POLICY.forbiddenRoleRule?.reason).toBe('ADVANCE_IN_OPENING');
    expect(MANUAL_ENTRY_POLICY.forbiddenRoleRule).toBeUndefined();
  });

  it('only CLOSING and credit/debit notes tolerate inactive accounts', () => {
    // A deactivated P&L account with FY movement must still be zeroed by the
    // year-end close; every other source type keeps the isActive check.
    expect(accountPolicyFor('CLOSING')).toBe(CLOSING_POLICY);
    expect(CLOSING_POLICY).toEqual({
      forbiddenRoles: [],
      allowInactive: true,
    });
    // A note mirrors its original's accounts, which may since be inactive.
    for (const t of ['SALES_CREDIT_NOTE', 'PURCHASE_DEBIT_NOTE'] as const)
      expect(accountPolicyFor(t)).toBe(NOTE_POLICY);
    expect(NOTE_POLICY).toEqual({ forbiddenRoles: [], allowInactive: true });
    for (const t of [
      'MANUAL',
      'OPENING',
      'REVERSAL',
      'SALES_INVOICE',
      'PURCHASE_BILL',
      'PAYMENT',
    ] as const) {
      expect(accountPolicyFor(t).allowInactive ?? false).toBe(false);
    }
  });

  it('returns the first forbidden account in input order', () => {
    const hit = findForbiddenRole(
      [
        { id: 'kas', role: 'CASH' },
        { id: 'ap', role: 'AP_CONTROL' },
        { id: 'ar', role: 'AR_CONTROL' },
      ],
      MANUAL_ENTRY_POLICY,
    );
    expect(hit).toEqual({ accountId: 'ap', role: 'AP_CONTROL' });
  });

  it('returns null when no role is forbidden (role-less, CASH, or unrestricted policy)', () => {
    expect(
      findForbiddenRole(
        [
          { id: 'x', role: null },
          { id: 'kas', role: 'CASH' },
        ],
        MANUAL_ENTRY_POLICY,
      ),
    ).toBeNull();
    expect(
      findForbiddenRole(
        [{ id: 'ar', role: 'AR_CONTROL' }],
        UNRESTRICTED_POLICY,
      ),
    ).toBeNull();
  });

  it('OPENING forbids REVENUE/EXPENSE accounts (balance-sheet positions only)', () => {
    expect(accountPolicyFor('OPENING')).toBe(OPENING_POLICY);
    const hit = findForbiddenType(
      [
        { id: 'kas', type: 'ASSET' },
        { id: 'exp', type: 'EXPENSE' },
        { id: 'rev', type: 'REVENUE' },
      ],
      OPENING_POLICY,
    );
    expect(hit).toEqual({ accountId: 'exp', reason: 'PNL_IN_OPENING' });
    expect(
      findForbiddenType(
        [
          { id: 'kas', type: 'ASSET' },
          { id: 'ap', type: 'LIABILITY' },
          { id: 'eq', type: 'EQUITY' },
        ],
        OPENING_POLICY,
      ),
    ).toBeNull();
  });

  it('no other source type forbids an account type', () => {
    for (const t of [
      'MANUAL',
      'CLOSING',
      'REVERSAL',
      'SALES_INVOICE',
      'PURCHASE_BILL',
      'PAYMENT',
      'SALES_CREDIT_NOTE',
      'PURCHASE_DEBIT_NOTE',
    ] as const) {
      expect(
        findForbiddenType(
          [
            { id: 'rev', type: 'REVENUE' },
            { id: 'exp', type: 'EXPENSE' },
          ],
          accountPolicyFor(t),
        ),
      ).toBeNull();
    }
  });
});
