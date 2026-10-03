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
 *
 * LINEAR TIME: the trim scans code units from both ends — never
 * an alternation regex like `/^\s+|\s+$/g`, which is O(N²) on 'a' + N
 * spaces + 'a' (a ~1 MB body blocked the event loop for minutes). Every
 * regex here matches a bounded window per position (no nested / overlapping
 * unbounded quantifiers); the unit spec keeps a < 100 ms budget on ~1 MB.
 */

/** One Unicode White_Space character. Every White_Space code point is in the
 *  BMP, so testing single UTF-16 code units is exact (a surrogate half never
 *  matches). */
const WHITE_SPACE_CHAR = /^\p{White_Space}$/u;

/** `s` without leading / trailing Unicode White_Space. O(length). */
function trimWhiteSpace(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && WHITE_SPACE_CHAR.test(s[start])) start++;
  while (end > start && WHITE_SPACE_CHAR.test(s[end - 1])) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

/**
 * Longest string the DTO transforms normalize (`@IdentifierCode()` /
 * `@DisplayName()`): longer values are passed through UNTOUCHED and the
 * field's `@MaxLength` (≤ 160) rejects them. Bounds the work an oversized
 * body can cause (NFKC can expand a string up to 18×) — defense in depth on
 * top of the linear-time trim.
 */
export const MAX_NORMALIZED_INPUT_LENGTH = 1024;

/** Invisible characters forbidden in identifier CODES (they make look-alike
 *  duplicates): Unicode general category Cf (format: U+200B ZWSP, U+200D ZWJ,
 *  U+FEFF, U+00AD soft hyphen, bidi overrides…), Cc (control, incl. tab /
 *  newline / NEL), Default_Ignorable_Code_Point (renders as nothing: U+034F
 *  combining grapheme joiner, Hangul fillers U+115F / U+1160 / U+3164 /
 *  U+FFA0, Khmer U+17B4 / U+17B5, Mongolian U+180B–U+180F, variation
 *  selectors, tags U+E0000–U+E0FFF…) and the line / paragraph separators
 *  Zl / Zp (U+2028 / U+2029). Interior only in practice: the edge trim
 *  already removed edge White_Space (NEL, U+2028, U+2029). Migration
 *  20261005000000_identifier_code_ci_unique blocks on exactly this set (its
 *  e2e spec compares the two code point by code point). */
export const CODE_INVISIBLE =
  /[\p{Cf}\p{Cc}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/u;
/** Invisible characters forbidden in display NAMES: Cf and
 *  Default_Ignorable_Code_Point (control characters stay allowed). */
const NAME_INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;

/** Canonical form of an identifier code: NFKC, then edge white space trimmed. */
export function normalizeIdentifierCode(value: string): string {
  return trimWhiteSpace(value.normalize('NFKC'));
}

/** Canonical form of a display name: edge white space trimmed. */
export function normalizeDisplayName(value: string): string {
  return trimWhiteSpace(value);
}

/** True when `s` holds an invisible character forbidden in identifier codes
 *  (see CODE_INVISIBLE). */
export function hasFormatOrControlChars(s: string): boolean {
  return CODE_INVISIBLE.test(s);
}

/** VS16 (U+FE0F, emoji presentation) right after an emoji character (❤️,
 *  🏳️, keycap 1️⃣): visible, legitimate text. Fixed-width match. */
const EMOJI_VS16 = /(\p{Emoji})\u{FE0F}/gu;

/** A ZERO WIDTH JOINER inside an emoji ZWJ sequence (👨‍👩‍👧, 🏳️‍🌈): the ZWJ
 *  sits between two pictographs (the first optionally followed by a
 *  skin-tone modifier; a VS16 is removed first by EMOJI_VS16). That is
 *  visible, legitimate text, not a hidden character — so a display name may
 *  keep it. Fixed-width match + a one-character lookahead. */
const EMOJI_ZWJ =
  /(\p{Extended_Pictographic}\p{Emoji_Modifier}?)\u200D(?=\p{Extended_Pictographic})/gu;

/** True when `s` holds an invisible character forbidden in display names
 *  (Cf / Default_Ignorable) other than the VS16 of an emoji or the ZWJ of an
 *  emoji ZWJ sequence. */
export function hasFormatChars(s: string): boolean {
  return NAME_INVISIBLE.test(
    s.replace(EMOJI_VS16, '$1').replace(EMOJI_ZWJ, '$1'),
  );
}

/** Non-blank message shared by the code/name DTOs' `@Matches(/\S/)`. */
export const NON_BLANK_MESSAGE = '$property must not be blank';
