import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { Matches } from 'class-validator';

/** A stored NPWP: exactly 16 digits. */
export const NPWP_FORMAT = /^\d{16}$/;

/**
 * NPWP as stored: its 16 digits (the Coretax TIN). Input may carry the usual
 * punctuation ('01.234.567.8-901.000') — '.', '-' and white space are
 * stripped — and a legacy 15-digit NPWP becomes '0' + 15 digits, DJP's
 * 16-digit form of it (PMK 112/2022). Anything else is left as typed for the
 * `^\d{16}$` check to reject (400). Same rule as migration 20261010000000.
 */
export function normalizeNpwp(value: string): string {
  const digits = value.replace(/[.\-\s]/g, '');
  return /^\d{15}$/.test(digits) ? `0${digits}` : digits;
}

/** DTO decorator for a nullable `npwp` field (pair with `@IsOptional()`,
 *  `@IsString()`, `@MaxLength(32)` — the cap applies before stripping). */
export function Npwp(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' && value.length <= 32
        ? normalizeNpwp(value)
        : value,
    ),
    Matches(NPWP_FORMAT, {
      message:
        'npwp must be a 16-digit NPWP (a legacy 15-digit NPWP is accepted and stored as 0 + 15 digits)',
    }),
  );
}
