import { Decimal } from 'decimal.js';

const SCALE = 4;

export class Money {
  private readonly value: Decimal;

  private constructor(value: Decimal) {
    this.value = value.toDecimalPlaces(SCALE, Decimal.ROUND_HALF_UP);
  }

  static of(amount: string | number | Decimal): Money {
    return new Money(new Decimal(amount));
  }

  static zero(): Money {
    return new Money(new Decimal(0));
  }

  static sum(amounts: Money[]): Money {
    return amounts.reduce((acc, m) => acc.add(m), Money.zero());
  }

  add(other: Money): Money {
    return new Money(this.value.plus(other.value));
  }

  subtract(other: Money): Money {
    return new Money(this.value.minus(other.value));
  }

  multiply(factor: string | number | Decimal): Money {
    return new Money(this.value.times(new Decimal(factor)));
  }

  roundToRupiah(): Money {
    return new Money(this.value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP));
  }

  equals(other: Money): boolean {
    return this.value.equals(other.value);
  }

  greaterThan(other: Money): boolean {
    return this.value.greaterThan(other.value);
  }

  lessThan(other: Money): boolean {
    return this.value.lessThan(other.value);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  toString(): string {
    return this.value.toFixed(SCALE);
  }

  toPersistence(): string {
    return this.value.toFixed(SCALE);
  }
}
