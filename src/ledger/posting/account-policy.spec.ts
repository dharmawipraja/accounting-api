import {
  MANUAL_ENTRY_POLICY,
  UNRESTRICTED_POLICY,
  accountPolicyFor,
  findForbiddenRole,
} from './account-policy';

describe('account-policy', () => {
  it('restricts only MANUAL entries (AR/AP control forbidden)', () => {
    expect(accountPolicyFor('MANUAL')).toBe(MANUAL_ENTRY_POLICY);
    for (const t of [
      'OPENING',
      'CLOSING',
      'REVERSAL',
      'SALES_INVOICE',
      'PURCHASE_BILL',
      'PAYMENT',
    ] as const) {
      expect(accountPolicyFor(t)).toBe(UNRESTRICTED_POLICY);
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
});
