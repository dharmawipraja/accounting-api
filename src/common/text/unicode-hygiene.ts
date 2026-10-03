/**
 * Characters Postgres cannot store — shared by the InputHygieneGuard
 * (reject) and the audit sanitizer (repair):
 *  - a LONE UTF-16 surrogate (a high surrogate not followed by a low one, or
 *    a low surrogate not preceded by a high one) — i.e. not `isWellFormed()`.
 *    JSON.parse turns a `"\ud800"` escape into one; node-pg silently stores
 *    it in a text column as U+FFFD, while jsonb rejects the escape outright
 *    (lost audit row). Valid surrogate PAIRS (emoji, astral CJK) pass.
 *  - U+0000 (NUL): text rejects it (22021) and jsonb rejects `\u0000`.
 */
const NUL = '\u0000';

/** True when `s` holds a lone surrogate or U+0000. Pure. */
export function hasInvalidCharacters(s: string): boolean {
  return s.includes(NUL) || !s.isWellFormed();
}

/** `s` made storable: every lone surrogate replaced by U+FFFD
 *  (`toWellFormed`), THEN U+0000 removed — in that order, so halves separated
 *  only by a NUL are never glued into a pair the client did not send.
 *  Well-formed text (incl. surrogate pairs) is returned unchanged. Pure. */
export function toStorableString(s: string): string {
  if (!hasInvalidCharacters(s)) return s;
  return s.toWellFormed().split(NUL).join('');
}
