import { ValidationFailedError } from '../../common/errors/domain-errors';
import { AccountRole } from '@prisma/client';
import {
  assertCashAssignable,
  assertRoleShape,
  ROLE_SHAPES,
} from './cash-role';
import { CHART_OF_ACCOUNTS } from './chart-of-accounts.seed';

describe('assertCashAssignable (CASH role shape rule)', () => {
  const ok = {
    type: 'ASSET',
    normalBalance: 'DEBIT',
    isPostable: true,
    role: null,
  } as const;

  it('accepts a postable, debit-normal ASSET without a role', () => {
    expect(() => assertCashAssignable(ok)).not.toThrow();
  });

  it('accepts an account that already holds CASH (idempotent re-assign)', () => {
    expect(() => assertCashAssignable({ ...ok, role: 'CASH' })).not.toThrow();
  });

  it.each([
    ['a non-ASSET', { type: 'LIABILITY', normalBalance: 'CREDIT' }],
    ['a credit-normal (contra) ASSET', { normalBalance: 'CREDIT' }],
    ['a non-postable header', { isPostable: false }],
  ])('rejects %s (422)', (_label, patch) => {
    expect(() => assertCashAssignable({ ...ok, ...patch })).toThrow(
      ValidationFailedError,
    );
  });

  it('rejects an account holding a singleton system role (422)', () => {
    expect(() => assertCashAssignable({ ...ok, role: 'AR_CONTROL' })).toThrow(
      /system role AR_CONTROL/,
    );
  });

  it('rejects an account used by a tax code, even a soft-deleted one (422)', () => {
    expect(() =>
      assertCashAssignable({ ...ok, id: 'a1', usedByTaxCode: true }),
    ).toThrow(/tax account/);
  });

  it('carries the offending shape in details', () => {
    try {
      assertCashAssignable({ ...ok, id: 'a1', isPostable: false });
      fail('expected throw');
    } catch (e) {
      expect((e as ValidationFailedError).details).toMatchObject({
        id: 'a1',
        type: 'ASSET',
        normalBalance: 'DEBIT',
        isPostable: false,
      });
    }
  });
});

describe('assertRoleShape (every system role)', () => {
  it('has a shape for every AccountRole, matching the seed chart', () => {
    expect(Object.keys(ROLE_SHAPES).sort()).toEqual(
      Object.values(AccountRole).sort(),
    );
    for (const a of CHART_OF_ACCOUNTS.filter((x) => x.role))
      expect(() =>
        assertRoleShape(a.role!, {
          type: a.type,
          normalBalance: a.normalBalance,
          isPostable: a.isPostable ?? true,
        }),
      ).not.toThrow();
  });

  it.each([
    ['AR_CONTROL', 'LIABILITY', 'CREDIT', true],
    ['AP_CONTROL', 'ASSET', 'DEBIT', true],
    ['RETAINED_EARNINGS', 'EQUITY', 'DEBIT', true],
    ['TAX_EXPENSE', 'EXPENSE', 'DEBIT', false],
    ['CUSTOMER_ADVANCE', 'ASSET', 'DEBIT', true],
  ] as const)('rejects %s on %s/%s postable=%s (422)', (role, type, nb, p) => {
    expect(() =>
      assertRoleShape(role, { type, normalBalance: nb, isPostable: p }),
    ).toThrow(ValidationFailedError);
  });
});
