import { Money } from '../../common/money/money';

/** Net signed so the account's NORMAL side is positive (debit-normal → debit−credit;
 *  credit-normal → credit−debit). The trial-balance / general-ledger convention: every
 *  account's own balance as a positive-on-its-normal-side magnitude. A contra account
 *  (normalBalance opposite its type) reads positive here. */
export function signedNet(
  normalBalance: string,
  debit: Money,
  credit: Money,
): Money {
  return normalBalance === 'DEBIT'
    ? debit.subtract(credit)
    : credit.subtract(debit);
}

/** Amount on the account TYPE's natural side (asset/expense → debit−credit;
 *  liability/equity/revenue → credit−debit). The financial-statement convention: a contra
 *  account nets AGAINST its parent type (accumulated depreciation reduces assets), so it
 *  reads negative here. Differs from signedNet only for contra accounts. */
export function naturalSide(type: string, debit: Money, credit: Money): Money {
  const debitNatured = type === 'ASSET' || type === 'EXPENSE';
  return debitNatured ? debit.subtract(credit) : credit.subtract(debit);
}
