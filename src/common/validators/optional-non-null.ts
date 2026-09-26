import { applyDecorators } from '@nestjs/common';
import { IsDefined, ValidateIf } from 'class-validator';

/**
 * For PATCH fields backed by a NON-nullable column: the key may be omitted
 * (keep the current value), but an explicit `null` is a 400 from the
 * validator — never a Prisma error. Use instead of `@IsOptional()` (which
 * skips validation for `null` too). Nullable fields that document
 * "send null to clear" keep `@IsOptional()`.
 */
export function OptionalNonNull(): PropertyDecorator {
  return applyDecorators(
    ValidateIf((_o: unknown, v: unknown) => v !== undefined),
    IsDefined({ message: '$property must not be null' }),
  );
}
