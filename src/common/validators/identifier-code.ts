import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { ValidateBy } from 'class-validator';
import {
  hasFormatChars,
  hasFormatOrControlChars,
  normalizeDisplayName,
  normalizeIdentifierCode,
} from '../text/identifier';

/**
 * Identifier CODE field (partner / account / tax-code `code`, `parentCode`):
 * the value is normalized (`normalizeIdentifierCode`: NFKC + edge trim) BEFORE
 * class-validator runs, and a code holding a Unicode format (Cf, e.g. U+200B)
 * or control (Cc) character is a 400. Pair it with `@IsString()`,
 * `@Matches(/\S/, { message: NON_BLANK_MESSAGE })` (blank after
 * normalization → 400) and `@MaxLength(n)` written on the DTO itself, so the
 * Swagger CLI plugin still emits `pattern` / `maxLength` (it cannot see
 * through this composite). Non-strings pass through untouched (@IsString
 * rejects them).
 */
export function IdentifierCode(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? normalizeIdentifierCode(value) : value,
    ),
    ValidateBy({
      name: 'isIdentifierCode',
      validator: {
        validate: (v: unknown) =>
          typeof v !== 'string' || !hasFormatOrControlChars(v),
        defaultMessage: () =>
          '$property must not contain invisible format or control characters (e.g. a zero-width space)',
      },
    }),
  );
}

/**
 * Display NAME field (partner / account / tax-code `name`): edge white space
 * trimmed before validation (`normalizeDisplayName`) and a Unicode format
 * (Cf) character is a 400. Same pairing rules as `@IdentifierCode()`.
 */
export function DisplayName(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? normalizeDisplayName(value) : value,
    ),
    ValidateBy({
      name: 'isDisplayName',
      validator: {
        validate: (v: unknown) => typeof v !== 'string' || !hasFormatChars(v),
        defaultMessage: () =>
          '$property must not contain invisible format characters (e.g. a zero-width space)',
      },
    }),
  );
}
