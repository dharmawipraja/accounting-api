import { registerDecorator, ValidationOptions } from 'class-validator';
import {
  AUDIT_YEAR_MAX,
  AUDIT_YEAR_MIN,
  isAuditInstantString,
} from '../dates/parse-date';

/** Used ALONE (it subsumes @IsDateString) on the audit-log `from` / `to` filters: a
 *  strict ISO date or date-time (`YYYY-MM-DD[THH:MM[:SS[.f]]][Z|±HH:MM]`)
 *  on a real calendar day with a year in 1970–9999 — anything else is a 400
 *  (never a silently shifted day or a Postgres out-of-range 500), with ONE
 *  validation message (non-strings fail it too). */
export function IsAuditInstant(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isAuditInstant',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => isAuditInstantString(value),
        defaultMessage: () =>
          `${propertyName} must be a real ISO date or date-time (YYYY-MM-DD[THH:MM[:SS[.fff]]][Z|±HH:MM]) with a year in ${AUDIT_YEAR_MIN}-${AUDIT_YEAR_MAX}`,
      },
    });
  };
}
