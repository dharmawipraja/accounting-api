import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';

const MONEY_RE = /^\d+(\.\d{1,4})?$/;

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
          return `${args.property} must be a non-negative decimal string with up to 4 decimal places`;
        },
      },
    });
  };
}
