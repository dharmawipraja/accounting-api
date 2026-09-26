import { Prisma } from '@prisma/client';
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

  it('multiplies by a Money or Prisma.Decimal factor (quantity x price)', () => {
    expect(Money.of('2500').multiply(Money.of('3')).toString()).toBe(
      '7500.0000',
    );
    expect(
      Money.of('1000').multiply(new Prisma.Decimal('0.11')).toString(),
    ).toBe('110.0000');
  });

  it('rejects a JS number factor at the type level', () => {
    type Factor = Parameters<Money['multiply']>[0];
    // @ts-expect-error — a float factor must not reach decimal math (compile-time only)
    const bad: Factor = 0.1;
    void bad;
  });

  it('rounds to whole rupiah (half-up)', () => {
    expect(Money.of('110000.5').roundToRupiah().toString()).toBe('110001.0000');
    expect(Money.of('110000.4').roundToRupiah().toString()).toBe('110000.0000');
  });

  it('multiplyToRupiah rounds the raw product once (half-up), not at 4dp first', () => {
    // 100004.5450 * 0.11 = 11000.49995 → 11000 (4dp-then-0dp would give 11001)
    expect(Money.of('100004.5450').multiplyToRupiah('0.11').toString()).toBe(
      '11000.0000',
    );
    expect(Money.of('333333').multiplyToRupiah('0.11').toString()).toBe(
      '36667.0000',
    );
    expect(Money.of('100').multiplyToRupiah('0.005').toString()).toBe('1.0000');
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
  describe('precision (40 significant digits, not decimal.js default 20)', () => {
    it('multiplies a max-size amount by a 4dp factor exactly before 4dp rounding', () => {
      // Exact product 14071089295460.91884196 has 22 significant digits.
      expect(Money.of('7111639187031.6986').multiply('1.9786').toString()).toBe(
        '14071089295460.9188',
      );
    });

    it('multiplyToRupiah rounds the exact product once (no 20-digit pre-rounding)', () => {
      // Exact product 1629137389230247.4999613606 → 247; a 20-significant-digit
      // intermediate would read .5000 and round up to 248.
      expect(
        Money.of('5249811935403587.5522')
          .multiplyToRupiah('0.310323')
          .toString(),
      ).toBe('1629137389230247.0000');
    });

    it('sums max-size amounts past 20 significant digits without rounding', () => {
      const big = Money.of('9999999999999999.9999');
      expect(Money.sum([big, big, big]).toString()).toBe(
        '29999999999999999.9997',
      );
    });

    it('interoperates with Prisma.Decimal unchanged', () => {
      const d = new Prisma.Decimal('7111639187031.6986');
      expect(
        Money.of(d).multiply(new Prisma.Decimal('1.9786')).toString(),
      ).toBe('14071089295460.9188');
    });
  });
});
