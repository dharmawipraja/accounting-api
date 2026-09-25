import { Transform } from 'class-transformer';

/** Canonical email form: emails are case-insensitive identifiers here. The DB
 *  backs this with a unique index on lower(email) (users_email_lower_key). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** DTO transform: normalize before class-validator runs (@IsEmail sees the
 *  trimmed value, so '  A@B.com ' is accepted as 'a@b.com'). */
export const NormalizeEmail = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeEmail(value) : value,
  );
