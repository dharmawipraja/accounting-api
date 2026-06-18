import { assertBalanced } from './assert-balanced';
import { UnbalancedEntryError } from '../../common/errors/domain-errors';

describe('assertBalanced', () => {
  it('accepts a balanced two-line entry', () => {
    expect(() =>
      assertBalanced([
        { accountId: 'a', debit: '100.0000' },
        { accountId: 'b', credit: '100.0000' },
      ]),
    ).not.toThrow();
  });
  it('rejects fewer than two lines', () => {
    expect(() => assertBalanced([{ accountId: 'a', debit: '100' }])).toThrow(
      UnbalancedEntryError,
    );
  });
  it('rejects a line with both debit and credit', () => {
    expect(() =>
      assertBalanced([
        { accountId: 'a', debit: '100', credit: '100' },
        { accountId: 'b', credit: '100' },
      ]),
    ).toThrow(UnbalancedEntryError);
  });
  it('rejects a line with neither debit nor credit', () => {
    expect(() =>
      assertBalanced([{ accountId: 'a' }, { accountId: 'b', credit: '100' }]),
    ).toThrow(UnbalancedEntryError);
  });
  it('rejects unequal totals', () => {
    expect(() =>
      assertBalanced([
        { accountId: 'a', debit: '100' },
        { accountId: 'b', credit: '90' },
      ]),
    ).toThrow(UnbalancedEntryError);
  });
  it('accepts a balanced multi-line entry', () => {
    expect(() =>
      assertBalanced([
        { accountId: 'a', debit: '60' },
        { accountId: 'b', debit: '40' },
        { accountId: 'c', credit: '100' },
      ]),
    ).not.toThrow();
  });
});
