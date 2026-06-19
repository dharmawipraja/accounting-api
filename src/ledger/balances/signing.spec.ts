import { Money } from '../../common/money/money';
import { signedNet, naturalSide } from './signing';

const M = (v: string) => Money.of(v);

describe('signedNet (by normalBalance)', () => {
  it('debit-normal → debit − credit', () => {
    expect(signedNet('DEBIT', M('1000'), M('300')).toPersistence()).toBe(
      '700.0000',
    );
  });
  it('credit-normal → credit − debit', () => {
    expect(signedNet('CREDIT', M('300'), M('1000')).toPersistence()).toBe(
      '700.0000',
    );
  });
});

describe('naturalSide (by type, contra-aware)', () => {
  it('ASSET → debit − credit', () => {
    expect(naturalSide('ASSET', M('1000'), M('300')).toPersistence()).toBe(
      '700.0000',
    );
  });
  it('EXPENSE → debit − credit', () => {
    expect(naturalSide('EXPENSE', M('500'), M('0')).toPersistence()).toBe(
      '500.0000',
    );
  });
  it('LIABILITY → credit − debit', () => {
    expect(naturalSide('LIABILITY', M('200'), M('900')).toPersistence()).toBe(
      '700.0000',
    );
  });
  it('EQUITY → credit − debit', () => {
    expect(naturalSide('EQUITY', M('0'), M('1000')).toPersistence()).toBe(
      '1000.0000',
    );
  });
  it('REVENUE → credit − debit', () => {
    expect(naturalSide('REVENUE', M('50'), M('1050')).toPersistence()).toBe(
      '1000.0000',
    );
  });
});

describe('the two conventions diverge for a contra account', () => {
  // Akumulasi Penyusutan: type ASSET, normalBalance CREDIT, credit-heavy.
  const debit = M('0');
  const credit = M('800');
  it('naturalSide nets a contra-asset NEGATIVE (reduces assets)', () => {
    expect(naturalSide('ASSET', debit, credit).toPersistence()).toBe(
      '-800.0000',
    );
  });
  it('signedNet reads the contra-asset POSITIVE (its own normal-side balance)', () => {
    expect(signedNet('CREDIT', debit, credit).toPersistence()).toBe('800.0000');
  });
});
