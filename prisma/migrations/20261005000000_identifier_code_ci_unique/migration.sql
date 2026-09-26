-- AUDIT3 iteration-8 (Task 29): identifier codes are unique CASE-INSENSITIVELY
-- among live rows. The API now normalizes every partner / account / tax-code
-- `code` on write (NFKC, edge white space trimmed; blank, zero-width / other
-- Unicode format (Cf) and control characters rejected — see
-- src/common/text/identifier.ts), so 'DUP', 'dup', ' DUP ' and full-width
-- 'ＤＵＰ' are one code. This migration normalizes the existing live codes
-- (or refuses — see below) and adds, per table, a partial expression unique
-- index on lower(code) WHERE deleted_at IS NULL.
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
-- Existing live rows are brought in line with the new rule inside ONE DO
-- block (all-or-nothing), in this order:
--   1. BLOCKING checks — the deploy FAILS (nothing changed) and lists table +
--      code + id when any live row
--        a. collides with another once normalized
--           (lower(trim(NFKC(code)))) — rename or delete all but one;
--        b. is blank once normalized (NFKC + trim) — give it a real code;
--        c. still holds a zero-width / other Unicode format (Cf) or control
--           (Cc) character once normalized — not mechanically fixable (which
--           visible code was meant?), so a human picks the new code. Tested on
--           the NORMALIZED form: edge tab / CR / LF are white space the API
--           trims too, so they are auto-fixed (step 2), not blocking.
--        d. would, once normalized, equal the exact code of a SOFT-DELETED
--           row (a legacy tombstone without the #deleted-<id> rename) — the
--           exact <table>_code_key unique would reject the rewrite.
--      Fix the listed rows (UPDATE <table> SET code = '<fixed>' WHERE id =
--      '<id>', or soft-delete them through the API), then
--      `prisma migrate resolve --rolled-back 20261005000000_identifier_code_ci_unique`
--      and re-run `prisma migrate deploy`.
--   2. AUTO-FIX — every other live code that is not in normalized form
--      (surrounding white space, NFKC-changing characters such as full-width
--      letters) is rewritten to trim(NFKC(code)), case kept; each change is
--      reported with RAISE NOTICE (table, id, old -> new). Safe: codes are
--      not FK targets nor copied into other rows, and step 1a guarantees the
--      new value collides with no other live code.
--   3. RE-VERIFY — no live code is left un-normalized (else fail).
DO $$
DECLARE
  -- Unicode Cf (format) code points PostgreSQL regexes cannot name by
  -- category: soft hyphen, Arabic/Syriac format marks, Mongolian vowel
  -- separator, zero-width space/joiners + LRM/RLM, bidi embeddings/overrides,
  -- word joiner + invisible operators, bidi isolates, BOM / ZWNBSP,
  -- interlinear annotation marks.
  cf constant text := '[­؀-؅؜۝܏᠎​-‏‪-‮⁠-⁤⁦-⁯﻿￹-￻]';
  -- trim(NFKC(code)) — the API's normalizeIdentifierCode.
  norm constant text := $n$regexp_replace(normalize(code, NFKC), '^[[:space:]]+|[[:space:]]+$', '', 'g')$n$;
  problems text := '';
  found text;
  r record;
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts', 'tax_codes', 'business_partners'] LOOP
    EXECUTE format($q$
      SELECT string_agg(k || ' <- ' || codes, '; ' ORDER BY k)
      FROM (
        SELECT lower(%s) AS k,
               string_agg(quote_literal(code) || ' (id ' || id || ')', ', '
                          ORDER BY code) AS codes
        FROM %I WHERE deleted_at IS NULL
        GROUP BY 1 HAVING count(*) > 1
      ) d $q$, norm, t) INTO found;
    IF found IS NOT NULL THEN
      problems := problems || format(E'\n  %s: live codes collide case-insensitively after normalization: %s', t, found);
    END IF;

    EXECUTE format($q$
      SELECT string_agg(quote_literal(code) || ' (id ' || id || ')', ', '
                        ORDER BY code)
      FROM %1$I
      WHERE deleted_at IS NULL
        AND (%2$s = '' OR %2$s ~ '[[:cntrl:]]' OR %2$s ~ %3$L) $q$, t, norm, cf)
      INTO found;
    IF found IS NOT NULL THEN
      problems := problems || format(E'\n  %s: live codes that cannot be normalized automatically (blank, or holding an invisible format / control character): %s', t, found);
    END IF;

    EXECUTE format($q$
      SELECT string_agg(quote_literal(l.code) || ' (id ' || l.id || ') vs deleted id ' || d.id, ', ')
      FROM %I l JOIN %I d
        ON d.deleted_at IS NOT NULL AND d.code = %s AND l.code <> d.code
      WHERE l.deleted_at IS NULL $q$, t, t, replace(norm, 'code', 'l.code'))
      INTO found;
    IF found IS NOT NULL THEN
      problems := problems || format(E'\n  %s: live codes whose normalized form equals a soft-deleted row''s code: %s', t, found);
    END IF;
  END LOOP;

  IF problems <> '' THEN
    RAISE EXCEPTION 'identifier code case-insensitive uniqueness aborted:%', problems
      USING HINT = 'Rename (UPDATE <table> SET code = ''<fixed>'' WHERE id = ''<id>'') or soft-delete the listed live rows, then mark this attempt rolled back (prisma migrate resolve --rolled-back 20261005000000_identifier_code_ci_unique) and re-run prisma migrate deploy. Nothing was changed by this run.';
  END IF;

  FOREACH t IN ARRAY ARRAY['accounts', 'tax_codes', 'business_partners'] LOOP
    FOR r IN EXECUTE format($q$
      UPDATE %I x SET code = n.new_code
      FROM (SELECT id, code AS old_code, %s AS new_code
            FROM %I WHERE deleted_at IS NULL) n
      WHERE x.id = n.id AND n.old_code <> n.new_code
      RETURNING x.id, n.old_code, n.new_code $q$, t, norm, t)
    LOOP
      RAISE NOTICE 'identifier code normalized: % id % : % -> %',
        t, r.id, quote_literal(r.old_code), quote_literal(r.new_code);
    END LOOP;

    EXECUTE format($q$
      SELECT string_agg(quote_literal(code) || ' (id ' || id || ')', ', ')
      FROM %I WHERE deleted_at IS NULL AND code <> %s $q$, t, norm)
      INTO found;
    IF found IS NOT NULL THEN
      RAISE EXCEPTION 'identifier code normalization left un-normalized live codes in %: %', t, found;
    END IF;
  END LOOP;
END $$;

-- Partial expression unique indexes: not expressible in schema.prisma. A
-- violation surfaces as P2002 → 409 via mapUniqueViolation / the global filter.
CREATE UNIQUE INDEX accounts_code_lower_live_key
  ON accounts (lower(code)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX tax_codes_code_lower_live_key
  ON tax_codes (lower(code)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX business_partners_code_lower_live_key
  ON business_partners (lower(code)) WHERE deleted_at IS NULL;
