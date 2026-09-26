import { Transform } from 'class-transformer';

/** Canonical email form: emails are case-insensitive identifiers here —
 *  trimmed, lowercased and Unicode NFC-normalized (so `jose\u0301@x.io`
 *  and `jos\u00e9@x.io` are one address). The DB backs this with a unique
 *  index on lower(email) (users_email_lower_key). The ONE implementation:
 *  users create/lookup, the login DTO, the login throttle key, the
 *  failed-login audit email and scripts/create-admin all call it. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase().normalize('NFC');
}

/** DTO transform: normalize before class-validator runs (@IsEmail sees the
 *  trimmed value, so '  A@B.com ' is accepted as 'a@b.com'). */
export const NormalizeEmail = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeEmail(value) : value,
  );
