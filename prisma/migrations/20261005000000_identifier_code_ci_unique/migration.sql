-- AUDIT3 iteration-8 (Task 29): identifier codes are unique CASE-INSENSITIVELY
-- among live rows. The API now normalizes every partner / account / tax-code
-- `code` on write (NFKC, edge white space trimmed; blank, zero-width / other
-- Unicode format (Cf) and control characters rejected — see
-- src/common/text/identifier.ts), so 'DUP', 'dup', ' DUP ' and full-width
-- 'ＤＵＰ' are one code. This migration adds, per table, a partial expression
-- unique index on lower(code) WHERE deleted_at IS NULL.
--
-- Tombstones: a soft-delete renames the code to '<code>#deleted-<id>'
-- (src/common/prisma/tombstone.ts) AND sets deleted_at, so tombstoned rows
-- are outside the new partial index and can never collide with a live code.
--
-- The exact-match unique indexes accounts_code_key / tax_codes_code_key /
-- business_partners_code_key are KEPT: they are what schema.prisma's
-- @@unique([code]) models (so `prisma migrate diff` stays empty), they span
-- tombstones (still unique thanks to the #deleted-<id> suffix) and, for live
-- rows, the lower(code) index is strictly stronger. Expression indexes cannot
-- be modelled in schema.prisma (see the comments on the models there) — same
-- pattern as users_email_lower_key.
--
-- Fail LOUDLY (no silent renaming — codes are referenced by humans, imports
-- and reports) when existing live rows would break the rule:
--   1. a group of live codes that collide once normalized
--      (lower(trim(NFKC(code)))) — rename or delete all but one;
--   2. a live code that is not in normalized form (edge white space, an
--      NFKC-changing character such as full-width letters, a zero-width /
--      format or control character, or blank) — the case-insensitive index
--      would not see ' DUP' vs 'DUP', so it must be corrected first, e.g.
--        UPDATE accounts SET code = '<fixed>' WHERE id = '<id>';
-- then `prisma migrate resolve --rolled-back 20261005000000_identifier_code_ci_unique`
-- and re-run `prisma migrate deploy` (nothing was changed by the failed run:
-- the check runs before any index is created).
DO $$
DECLARE
  -- Unicode Cf (format) code points PostgreSQL regexes cannot name by
  -- category: soft hyphen, Arabic/Syriac format marks, Mongolian vowel
  -- separator, zero-width space/joiners + LRM/RLM, bidi embeddings/overrides,
  -- word joiner + invisible operators, bidi isolates, BOM / ZWNBSP,
  -- interlinear annotation marks.
  cf constant text := '[­؀-؅؜۝܏᠎​-‏‪-‮⁠-⁤⁦-⁯﻿￹-￻]';
  problems text := '';
  found text;
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts', 'tax_codes', 'business_partners'] LOOP
    EXECUTE format($q$
      SELECT string_agg(k || ' <- ' || codes, '; ' ORDER BY k)
      FROM (
        SELECT lower(regexp_replace(normalize(code, NFKC),
                       '^[[:space:]]+|[[:space:]]+$', '', 'g')) AS k,
               string_agg(quote_literal(code) || ' (id ' || id || ')', ', '
                          ORDER BY code) AS codes
        FROM %I WHERE deleted_at IS NULL
        GROUP BY 1 HAVING count(*) > 1
      ) d $q$, t) INTO found;
    IF found IS NOT NULL THEN
      problems := problems || format(E'\n  %s: live codes collide case-insensitively after normalization: %s', t, found);
    END IF;

    EXECUTE format($q$
      SELECT string_agg(quote_literal(code) || ' (id ' || id || ')', ', '
                        ORDER BY code)
      FROM %I
      WHERE deleted_at IS NULL
        AND (code <> normalize(code, NFKC)
             OR code ~ '^[[:space:]]|[[:space:]]$'
             OR code !~ '[^[:space:]]'
             OR code ~ '[[:cntrl:]]'
             OR code ~ %L) $q$, t, cf) INTO found;
    IF found IS NOT NULL THEN
      problems := problems || format(E'\n  %s: live codes not in normalized form (NFKC, trimmed, non-blank, no format/control characters): %s', t, found);
    END IF;
  END LOOP;

  IF problems <> '' THEN
    RAISE EXCEPTION 'identifier code case-insensitive uniqueness aborted:%', problems
      USING HINT = 'Rename (UPDATE <table> SET code = ''<fixed>'' WHERE id = ''<id>'') or soft-delete the listed live rows so every live code is normalized and unique ignoring case, then mark this attempt rolled back (prisma migrate resolve --rolled-back 20261005000000_identifier_code_ci_unique) and re-run prisma migrate deploy.';
  END IF;
END $$;

-- Partial expression unique indexes: not expressible in schema.prisma. A
-- violation surfaces as P2002 → 409 via mapUniqueViolation / the global filter.
CREATE UNIQUE INDEX accounts_code_lower_live_key
  ON accounts (lower(code)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX tax_codes_code_lower_live_key
  ON tax_codes (lower(code)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX business_partners_code_lower_live_key
  ON business_partners (lower(code)) WHERE deleted_at IS NULL;
