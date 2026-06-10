import { Money } from './money';

describe('Money', () => {
  it('adds two amounts without floating-point error', () => {
    const result = Money.of('0.1').add(Money.of('0.2'));
    expect(result.toString()).toBe('0.3000');
  });

  it('subtracts amounts', () => {
    expect(Money.of('10').subtract(Money.of('3.5')).toString()).toBe('6.5000');
  });

  it('multiplies by a rate', () => {
    expect(Money.of('1000000').multiply('0.11').toString()).toBe('110000.0000');
  });

  it('rounds to whole rupiah (half-up)', () => {
    expect(Money.of('110000.5').roundToRupiah().toString()).toBe('110001.0000');
    expect(Money.of('110000.4').roundToRupiah().toString()).toBe('110000.0000');
  });

  it('compares amounts', () => {
    expect(Money.of('5').equals(Money.of('5.0000'))).toBe(true);
    expect(Money.of('5').greaterThan(Money.of('4'))).toBe(true);
    expect(Money.of('5').isZero()).toBe(false);
    expect(Money.zero().isZero()).toBe(true);
  });

  it('sums a list', () => {
    expect(
      Money.sum([
        Money.of('1.10'),
        Money.of('2.20'),
        Money.of('3.30'),
      ]).toString(),
    ).toBe('6.6000');
    expect(Money.sum([]).toString()).toBe('0.0000');
  });

  it('silently rounds to 4 decimal places on construction', () => {
    expect(Money.of('1.123456').toString()).toBe('1.1235');
  });

  it('serializes to a 4dp string for persistence', () => {
    expect(Money.of('1234.5').toPersistence()).toBe('1234.5000');
  });

  it('handles negative amounts', () => {
    expect(Money.of('-1000').add(Money.of('500')).toString()).toBe('-500.0000');
    expect(Money.of('100').subtract(Money.of('300')).toString()).toBe(
      '-200.0000',
    );
    expect(Money.of('-1').isNegative()).toBe(true);
  });

  it('rejects non-finite and non-numeric input', () => {
    expect(() => Money.of('not-a-number')).toThrow();
    expect(() => Money.of('Infinity')).toThrow();
    expect(() => Money.of('NaN')).toThrow();
  });
});
