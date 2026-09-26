import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { ValidateBy } from 'class-validator';
import {
  hasFormatChars,
  hasFormatOrControlChars,
  MAX_NORMALIZED_INPUT_LENGTH,
  normalizeDisplayName,
  normalizeIdentifierCode,
} from '../text/identifier';

/** A string short enough to normalize / scan. A longer one is left untouched
 *  and unchecked here: the field's `@MaxLength` (≤ 160) rejects it, so an
 *  oversized body costs no normalization work (iter9 ReDoS guard). */
const inBudget = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= MAX_NORMALIZED_INPUT_LENGTH;

/**
 * Identifier CODE field (partner / account / tax-code `code`, `parentCode`):
 * the value is normalized (`normalizeIdentifierCode`: NFKC + edge trim) BEFORE
 * class-validator runs, and a code holding an invisible character (Cf, e.g.
 * U+200B; Cc; Default_Ignorable; interior Zl / Zp — `CODE_INVISIBLE`) is a
 * 400. A value longer than MAX_NORMALIZED_INPUT_LENGTH is neither normalized
 * nor scanned (the `@MaxLength` rejects it). Pair it with `@IsString()`,
 * `@Matches(/\S/, { message: NON_BLANK_MESSAGE })` (blank after
 * normalization → 400) and `@MaxLength(n)` written on the DTO itself, so the
 * Swagger CLI plugin still emits `pattern` / `maxLength` (it cannot see
 * through this composite). Non-strings pass through untouched (@IsString
 * rejects them).
 */
export function IdentifierCode(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      inBudget(value) ? normalizeIdentifierCode(value) : value,
    ),
    ValidateBy({
      name: 'isIdentifierCode',
      validator: {
        validate: (v: unknown) => !inBudget(v) || !hasFormatOrControlChars(v),
        defaultMessage: () =>
          '$property must not contain invisible characters (format, control, default-ignorable or line / paragraph separator, e.g. a zero-width space)',
      },
    }),
  );
}

/**
 * Display NAME field (partner / account / tax-code `name`): edge white space
 * trimmed before validation (`normalizeDisplayName`) and a Unicode format
 * (Cf) or Default_Ignorable character is a 400 — except the VS16 / ZWJ of an
 * emoji (❤️, 👨‍👩‍👧). Same pairing rules as `@IdentifierCode()`.
 */
export function DisplayName(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      inBudget(value) ? normalizeDisplayName(value) : value,
    ),
    ValidateBy({
      name: 'isDisplayName',
      validator: {
        validate: (v: unknown) => !inBudget(v) || !hasFormatChars(v),
        defaultMessage: () =>
          '$property must not contain invisible format or default-ignorable characters (e.g. a zero-width space; emoji joiners / VS16 inside emoji are fine)',
      },
    }),
  );
}
