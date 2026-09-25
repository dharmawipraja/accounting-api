import { taxAccountViolation } from './tax-account-rule';

describe('taxAccountViolation (tax-code account rule)', () => {
  const payable = {
    id: 'a1',
    role: null,
    subtype: 'TAX_PAYABLE',
    normalBalance: 'CREDIT',
    isPostable: true,
  } as const;
  const receivable = {
    ...payable,
    subtype: 'TAX_RECEIVABLE',
    normalBalance: 'DEBIT',
  } as const;

  it.each([
    ['PPN_OUTPUT', payable],
    ['PPH_PAYABLE', payable],
    ['PPN_INPUT', receivable],
    ['PPH_PREPAID', receivable],
  ] as const)('accepts %s on a matching tax account', (kind, acct) => {
    expect(taxAccountViolation(kind, acct)).toBeNull();
  });

  it('rejects a non-postable account', () => {
    expect(
      taxAccountViolation('PPN_OUTPUT', { ...payable, isPostable: false }),
    ).toMatchObject({
      details: { taxAccountId: 'a1', reason: 'NOT_POSTABLE' },
    });
  });

  it.each(['CASH', 'AR_CONTROL', 'AP_CONTROL', 'TAX_EXPENSE'] as const)(
    'rejects an account holding the system role %s',
    (role) => {
      expect(
        taxAccountViolation('PPN_OUTPUT', { ...payable, role }),
      ).toMatchObject({
        details: { taxAccountId: 'a1', reason: 'SYSTEM_ROLE', role },
      });
    },
  );

  it('rejects the wrong normal balance for the kind', () => {
    expect(taxAccountViolation('PPN_INPUT', payable)).toMatchObject({
      details: { reason: 'NORMAL_BALANCE', normalBalance: 'CREDIT' },
    });
  });

  it('rejects a non-tax subtype (e.g. an ordinary current asset)', () => {
    expect(
      taxAccountViolation('PPN_INPUT', {
        ...receivable,
        subtype: 'CURRENT_ASSET',
      }),
    ).toMatchObject({
      details: {
        reason: 'SUBTYPE',
        subtype: 'CURRENT_ASSET',
        required: 'TAX_RECEIVABLE',
      },
    });
  });

  it('rejects the opposite tax subtype for the kind', () => {
    expect(
      taxAccountViolation('PPN_OUTPUT', {
        ...payable,
        subtype: 'TAX_RECEIVABLE',
      }),
    ).toMatchObject({
      details: { reason: 'SUBTYPE', required: 'TAX_PAYABLE' },
    });
  });
});
