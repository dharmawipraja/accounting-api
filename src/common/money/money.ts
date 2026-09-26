import { Decimal } from 'decimal.js';
import type { Prisma } from '@prisma/client';

const SCALE = 4;

/** Module-private decimal.js constructor with 40 significant digits. The
 *  library default (20) silently rounds intermediate products/sums of
 *  realistic amounts (16 integer digits + 4dp × a 6dp rate needs 26+), which
 *  can double-round (e.g. 7111639187031.6986 × 1.9786 → …9189 instead of the
 *  exact …9188). All Money arithmetic runs through this constructor, so every
 *  intermediate is exact before the single 4dp (or rupiah) rounding. Plain
 *  `Decimal` / `Prisma.Decimal` inputs are accepted and re-wrapped, unchanged. */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
type D = InstanceType<typeof D>;

export class Money {
  private readonly value: D;

  private constructor(value: D) {
    if (!value.isFinite()) {
      throw new Error(
        `Money cannot represent a non-finite value: ${value.toString()}`,
      );
    }
    // ROUND_HALF_UP matches Indonesian tax-invoice (Faktur Pajak) rounding.
    this.value = value.toDecimalPlaces(SCALE, D.ROUND_HALF_UP);
  }

  // Accepts string | Decimal only — never a JS number, so float arithmetic
  // cannot sneak in before the amount is wrapped in exact decimal math.
  static of(amount: string | Decimal): Money {
    return new Money(new D(amount));
  }

  static zero(): Money {
    return new Money(new D(0));
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
    const f = factor instanceof Money ? factor.value : new D(factor.toString());
    return new Money(this.value.times(f));
  }

  /** `this × factor` rounded ONCE to whole rupiah (half-up) from the exact
   *  product. Unlike `multiply(f).roundToRupiah()`, the product is not first
   *  rounded to 4dp (which can flip a .49995 up to .5000 → +1 rupiah). */
  multiplyToRupiah(factor: string | Money | Prisma.Decimal): Money {
    const f = factor instanceof Money ? factor.value : new D(factor.toString());
    return new Money(this.value.times(f).toDecimalPlaces(0, D.ROUND_HALF_UP));
  }

  roundToRupiah(): Money {
    return new Money(this.value.toDecimalPlaces(0, D.ROUND_HALF_UP));
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
