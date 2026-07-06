import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';

// Max 16 integer digits: the ledger columns are Decimal(20,4), so a longer
// value would overflow at the DB layer (P2020) instead of failing validation.
const MONEY_RE = /^\d{1,16}(\.\d{1,4})?$/;

export function IsMoneyString(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isMoneyString',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && MONEY_RE.test(value);
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be a non-negative decimal string with up to 16 integer digits and 4 decimal places`;
        },
      },
    });
  };
}
