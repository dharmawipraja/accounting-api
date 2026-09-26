import {
  RuleAccount,
  cashAccountViolation,
  documentLineAccountViolation,
} from './document-account-rules';

const acct = (over: Partial<RuleAccount>): RuleAccount => ({
  id: 'a1',
  role: null,
  type: 'REVENUE',
  subtype: 'REVENUE',
  normalBalance: 'CREDIT',
  ...over,
});

describe('documentLineAccountViolation', () => {
  it.each(['AR_CONTROL', 'AP_CONTROL', 'CASH'] as const)(
    'rejects a %s-role account on either nature with {accountId, role}',
    (role) => {
      for (const nature of ['SALE', 'PURCHASE'] as const) {
        expect(
          documentLineAccountViolation(nature, acct({ role }), false)?.details,
        ).toEqual({ accountId: 'a1', role });
      }
    },
  );

  it('rejects a tax account before applying the type rule', () => {
    const v = documentLineAccountViolation(
      'PURCHASE',
      acct({ type: 'ASSET', subtype: 'TAX_RECEIVABLE' }),
      true,
    );
    expect(v?.details).toEqual({ accountId: 'a1', reason: 'TAX_ACCOUNT' });
  });

  it('accepts REVENUE (any subtype) and OTHER_INCOME subtype on a sale', () => {
    expect(documentLineAccountViolation('SALE', acct({}), false)).toBeNull();
    expect(
      documentLineAccountViolation(
        'SALE',
        acct({ type: 'EXPENSE', subtype: 'OTHER_INCOME' }),
        false,
      ),
    ).toBeNull();
  });

  it('rejects a non-revenue account on a sale with reason ACCOUNT_TYPE', () => {
    const v = documentLineAccountViolation(
      'SALE',
      acct({ type: 'EXPENSE', subtype: 'OPERATING_EXPENSE' }),
      false,
    );
    expect(v?.details).toEqual({ accountId: 'a1', reason: 'ACCOUNT_TYPE' });
  });

  it('accepts EXPENSE and ASSET on a purchase, rejects REVENUE/LIABILITY/EQUITY', () => {
    expect(
      documentLineAccountViolation(
        'PURCHASE',
        acct({ type: 'EXPENSE', subtype: 'COGS', normalBalance: 'DEBIT' }),
        false,
      ),
    ).toBeNull();
    expect(
      documentLineAccountViolation(
        'PURCHASE',
        acct({ type: 'ASSET', subtype: 'FIXED_ASSET', normalBalance: 'DEBIT' }),
        false,
      ),
    ).toBeNull();
    for (const type of ['REVENUE', 'LIABILITY', 'EQUITY'] as const) {
      expect(
        documentLineAccountViolation('PURCHASE', acct({ type }), false)
          ?.details,
      ).toEqual({ accountId: 'a1', reason: 'ACCOUNT_TYPE' });
    }
  });
});

describe('documentLineAccountViolation — contra assets', () => {
  it('rejects a contra-asset (ASSET with CREDIT normal balance) on a purchase with reason CONTRA_ASSET', () => {
    const v = documentLineAccountViolation(
      'PURCHASE',
      acct({
        type: 'ASSET',
        subtype: 'ACCUMULATED_DEPRECIATION',
        normalBalance: 'CREDIT',
      }),
      false,
    );
    expect(v?.details).toEqual({ accountId: 'a1', reason: 'CONTRA_ASSET' });
  });
  it('keeps accepting a debit-normal asset on a purchase', () => {
    expect(
      documentLineAccountViolation(
        'PURCHASE',
        acct({ type: 'ASSET', subtype: 'FIXED_ASSET', normalBalance: 'DEBIT' }),
        false,
      ),
    ).toBeNull();
  });
});

describe('documentLineAccountViolation — contra revenue', () => {
  it('rejects a contra-revenue (REVENUE with DEBIT normal balance) on a sale with reason CONTRA_REVENUE', () => {
    const v = documentLineAccountViolation(
      'SALE',
      acct({ type: 'REVENUE', normalBalance: 'DEBIT' }),
      false,
    );
    expect(v?.details).toEqual({ accountId: 'a1', reason: 'CONTRA_REVENUE' });
    expect(v?.message).toMatch(/contra-revenue/);
  });
  it('keeps accepting a credit-normal revenue account on a sale', () => {
    expect(documentLineAccountViolation('SALE', acct({}), false)).toBeNull();
  });
});

describe('documentLineAccountViolation — contra expense', () => {
  it('rejects a contra-expense (EXPENSE with CREDIT normal balance) on a purchase with reason CONTRA_EXPENSE', () => {
    const v = documentLineAccountViolation(
      'PURCHASE',
      acct({
        type: 'EXPENSE',
        subtype: 'OPERATING_EXPENSE',
        normalBalance: 'CREDIT',
      }),
      false,
    );
    expect(v?.details).toEqual({ accountId: 'a1', reason: 'CONTRA_EXPENSE' });
    expect(v?.message).toMatch(/contra-expense/);
  });
  it('keeps accepting a debit-normal expense account on a purchase', () => {
    expect(
      documentLineAccountViolation(
        'PURCHASE',
        acct({
          type: 'EXPENSE',
          subtype: 'OPERATING_EXPENSE',
          normalBalance: 'DEBIT',
        }),
        false,
      ),
    ).toBeNull();
  });
});

describe('cashAccountViolation', () => {
  it('accepts only a CASH-role account', () => {
    expect(cashAccountViolation({ id: 'k', role: 'CASH' })).toBeNull();
    expect(
      cashAccountViolation({ id: 'ar', role: 'AR_CONTROL' })?.details,
    ).toEqual({ accountId: 'ar', role: 'AR_CONTROL' });
    expect(cashAccountViolation({ id: 'x', role: null })?.details).toEqual({
      accountId: 'x',
      role: null,
    });
  });
});
