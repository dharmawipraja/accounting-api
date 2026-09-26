/**
 * Normalization rules for identifier CODES (partner / account / tax-code
 * `code`, account `parentCode`) and display NAMES (partner / account /
 * tax-code `name`). Pure. Applied at the DTO boundary by the
 * `@IdentifierCode()` / `@DisplayName()` decorators and again (idempotently)
 * in the create / update methods of BusinessPartnersService, AccountsService
 * and TaxCodesService, so a caller bypassing the DTO gets the same rule.
 * Account `parentCode` is matched case-insensitively, like code uniqueness.
 *
 *  - code: NFKC (full-width `ＤＵＰ` → `DUP`, `①` → `1`, ideographic space →
 *    space) then trimmed of Unicode White_Space. Stored in that form (case
 *    kept); live-row uniqueness is case-insensitive in the DB
 *    (`lower(code) WHERE deleted_at IS NULL` unique indexes).
 *  - name: trimmed of Unicode White_Space only (no NFKC, no case change).
 *
 * The trim deliberately uses `\p{White_Space}`, not `String#trim`: JS trim
 * also strips U+FEFF (ZERO WIDTH NO-BREAK SPACE), which we want REJECTED as
 * a format character rather than silently removed at the ends only.
 */
const EDGE_WHITE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

/** Unicode general category Cf (format: U+200B ZWSP, U+200D ZWJ, U+FEFF,
 *  U+00AD soft hyphen, bidi overrides…) or Cc (control, incl. tab/newline). */
const FORMAT_OR_CONTROL = /[\p{Cf}\p{Cc}]/u;
/** Unicode general category Cf only. */
const FORMAT = /\p{Cf}/u;

/** Canonical form of an identifier code: NFKC, then edge white space trimmed. */
export function normalizeIdentifierCode(value: string): string {
  return value.normalize('NFKC').replace(EDGE_WHITE_SPACE, '');
}

/** Canonical form of a display name: edge white space trimmed. */
export function normalizeDisplayName(value: string): string {
  return value.replace(EDGE_WHITE_SPACE, '');
}

/** True when `s` holds an invisible format (Cf) or control (Cc) character —
 *  forbidden in identifier codes (they make look-alike duplicates). */
export function hasFormatOrControlChars(s: string): boolean {
  return FORMAT_OR_CONTROL.test(s);
}

/** A ZERO WIDTH JOINER inside an emoji ZWJ sequence (👨‍👩‍👧, 🏳️‍🌈): the ZWJ
 *  sits between two pictographs (the first optionally followed by VS16 or a
 *  skin-tone modifier). That is visible, legitimate text, not a hidden
 *  character — so a display name may keep it. */
const EMOJI_ZWJ =
  /(\p{Extended_Pictographic}(?:\u{FE0F}|\p{Emoji_Modifier})?)\u200D(?=\p{Extended_Pictographic})/gu;

/** True when `s` holds an invisible format (Cf) character — forbidden in
 *  display names — other than the ZWJ of an emoji ZWJ sequence. */
export function hasFormatChars(s: string): boolean {
  return FORMAT.test(s.replace(EMOJI_ZWJ, '$1'));
}

/** Non-blank message shared by the code/name DTOs' `@Matches(/\S/)`. */
export const NON_BLANK_MESSAGE = '$property must not be blank';
