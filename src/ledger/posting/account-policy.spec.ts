import {
  CLOSING_POLICY,
  MANUAL_ENTRY_POLICY,
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
    expect(accountPolicyFor('OPENING').forbiddenRoles).toEqual([]);
  });

  it('CLOSING is role-unrestricted and the ONLY policy that tolerates inactive accounts', () => {
    // A deactivated P&L account with FY movement must still be zeroed by the
    // year-end close; every other source type keeps the isActive check.
    expect(accountPolicyFor('CLOSING')).toBe(CLOSING_POLICY);
    expect(CLOSING_POLICY).toEqual({
      forbiddenRoles: [],
      allowInactive: true,
    });
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
