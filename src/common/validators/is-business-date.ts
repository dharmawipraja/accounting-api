import { ValidateBy, ValidationOptions } from 'class-validator';
import { isBusinessDateString } from '../dates/business-date';

/** Pair with @IsDateString() on every business-date field (JE/document/
 *  payment/due date, report asOf/from/to): IsDateString accepts ISO-shaped
 *  impossible days such as `2026-02-30`; this rejects them at the DTO boundary
 *  (400), consistent with other malformed dates. Kept as an extra decorator so
 *  the OpenAPI format inferred from IsDateString is unchanged. */
export const IsBusinessDate = (
  options?: ValidationOptions,
): PropertyDecorator =>
  ValidateBy(
    {
      name: 'isBusinessDate',
      validator: {
        validate: (value: unknown) => isBusinessDateString(value),
        defaultMessage: () =>
          '$property must be a real calendar date in YYYY-MM-DD form (no time)',
      },
    },
    options,
  );
