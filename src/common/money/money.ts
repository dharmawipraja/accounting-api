import { Decimal } from 'decimal.js';
import type { Prisma } from '@prisma/client';

const SCALE = 4;

export class Money {
  private readonly value: Decimal;

  private constructor(value: Decimal) {
    if (!value.isFinite()) {
      throw new Error(
        `Money cannot represent a non-finite value: ${value.toString()}`,
      );
    }
    // ROUND_HALF_UP matches Indonesian tax-invoice (Faktur Pajak) rounding.
    this.value = value.toDecimalPlaces(SCALE, Decimal.ROUND_HALF_UP);
  }

  // Accepts string | Decimal only — never a JS number, so float arithmetic
  // cannot sneak in before the amount is wrapped in exact decimal math.
  static of(amount: string | Decimal): Money {
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

  /** Multiply by a rate or quantity. Like `of()`, never a JS number — a float
   *  factor would reintroduce binary rounding before the decimal math. */
  multiply(factor: string | Money | Prisma.Decimal): Money {
    const f =
      factor instanceof Money ? factor.value : new Decimal(factor.toString());
    return new Money(this.value.times(f));
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

  isZero(): boolean {
    return this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  toPersistence(): string {
    return this.value.toFixed(SCALE);
  }

  toString(): string {
    return this.toPersistence();
  }
}
