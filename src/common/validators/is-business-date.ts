import { registerDecorator, ValidationOptions } from 'class-validator';
import { isBusinessDateString } from '../dates/business-date';

/** Pair with @IsDateString() on every business-date field (JE/document/
 *  payment/due date, report asOf/from/to): IsDateString accepts ISO-shaped
 *  impossible days such as `2026-02-30`; this rejects them at the DTO boundary
 *  (400), consistent with other malformed dates. Kept as an extra decorator so
 *  the OpenAPI format inferred from IsDateString is unchanged. */
export function IsBusinessDate(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isBusinessDate',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => isBusinessDateString(value),
        defaultMessage: () =>
          `${propertyName} must start with a real calendar date (YYYY-MM-DD)`,
      },
    });
  };
}
