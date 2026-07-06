import { randomInt } from 'crypto';

/** No 0/O/1/l/I — temp passwords are read aloud / retyped once. */
export const TEMP_PASSWORD_CHARSET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

const TEMP_PASSWORD_LENGTH = 16;

/** One-time password for admin create/reset; crypto-random, shown exactly once. */
export function generateTempPassword(): string {
  let out = '';
  for (let i = 0; i < TEMP_PASSWORD_LENGTH; i++) {
    out += TEMP_PASSWORD_CHARSET[randomInt(TEMP_PASSWORD_CHARSET.length)];
  }
  return out;
}
