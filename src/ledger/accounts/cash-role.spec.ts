import { ValidationFailedError } from '../../common/errors/domain-errors';
import { assertCashAssignable } from './cash-role';

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
