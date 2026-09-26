-- AUDIT3 iteration-8 (Task 29): identifier codes are unique CASE-INSENSITIVELY
-- among live rows. The API now normalizes every partner / account / tax-code
-- `code` on write (NFKC, edge white space trimmed; blank codes and invisible
-- characters — format / control / default-ignorable / line separators —
-- rejected, see src/common/text/identifier.ts), so 'DUP', 'dup', ' DUP ' and full-width
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
--           (lower(btrim(NFKC(code), <White_Space>))) — rename or delete all
--           but one;
--        b. is blank once normalized (NFKC + trim) — give it a real code;
--        c. still holds an invisible character once normalized — Unicode
--           format (Cf: zero-width space, bidi controls, tags…), control
--           (Cc), line / paragraph separator (Zl / Zp) or other
--           Default_Ignorable (combining grapheme joiner, Hangul fillers,
--           variation selectors…), the API's CODE_INVISIBLE set — not
--           mechanically fixable (which visible code was meant?), so a human
--           picks the new code. Tested on the NORMALIZED form: edge tab / CR
--           / LF / NEL / U+2028 are white space the API trims too, so they
--           are auto-fixed (step 2), not blocking.
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
--      recorded as an audit_log row (method 'MIGRATION', path = this
--      migration's name, body {table, id, old, new}, user_id NULL — list them
--      with GET /v1/audit?method=MIGRATION; `prisma migrate deploy` does not
--      print the RAISE NOTICE that repeats it). No change, no row. Safe: codes are
--      not FK targets nor copied into other rows, and step 1a guarantees the
--      new value collides with no other live code.
--   3. RE-VERIFY — no live code is left un-normalized (else fail).
DO $$
DECLARE
  -- The API's CODE_INVISIBLE (src/common/text/identifier.ts): Unicode Cc
  -- (control; U+0000 cannot occur in text), Cf (format), Zl / Zp (line /
  -- paragraph separator) and Default_Ignorable_Code_Point (U+034F, Hangul
  -- fillers, Khmer U+17B4/5, Mongolian U+180B–180F, variation selectors,
  -- tags U+E0000–E0FFF, …), as Unicode 16 ranges — PostgreSQL regexes cannot
  -- name these properties. test/identifier-code-migration.e2e-spec.ts checks
  -- this class code point by code point against the JS regex.
  invisible constant text := '[\u0001-\u001F\u007F-\u009F\u00AD\u034F\u0600-\u0605\u061C\u06DD\u070F\u0890-\u0891\u08E2\u115F-\u1160\u17B4-\u17B5\u180B-\u180F\u200B-\u200F\u2028-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFFB\U000110BD\U000110CD\U00013430-\U0001343F\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0000-\U000E0FFF]';
  -- Unicode White_Space as a btrim() character set — the API's
  -- normalizeIdentifierCode trims JS \p{White_Space}: tab, LF, VT, FF, CR,
  -- space, NEL, NBSP, U+1680, U+2000–200A, U+2028, U+2029, U+202F, U+205F,
  -- U+3000 (NOT U+180E / U+200B / U+FEFF, which are blocked as invisible
  -- instead). The e2e spec compares this set with \p{White_Space} too.
  ws constant text := $w$E'\u0009\u000A\u000B\u000C\u000D\u0020\u0085\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000'$w$;
  -- btrim(NFKC(code), <White_Space>) — the API's normalizeIdentifierCode.
  -- btrim is linear (no regex).
  norm constant text := format('btrim(normalize(code, NFKC), %s)', ws);
  -- A code as shown in this migration's messages: quoted, with every
  -- invisible or non-space White_Space character written as \uXXXX /
  -- \UXXXXXXXX. Readable for the operator AND safe to print — a raw U+2028
  -- / U+2029 in the error text breaks `prisma migrate deploy`'s JSON-RPC
  -- with its schema engine (the CLI hangs instead of reporting the error).
  -- `%s` = the text expression to show.
  shown constant text := format($s$(SELECT '''' || coalesce(string_agg(
      CASE WHEN c ~ %1$L OR (c <> ' ' AND btrim(c, %2$s) = '')
           THEN CASE WHEN ascii(c) > 65535
                     THEN '\U' || lpad(upper(to_hex(ascii(c))), 8, '0')
                     ELSE '\u' || lpad(upper(to_hex(ascii(c))), 4, '0') END
           ELSE c END, '' ORDER BY i), '') || ''''
    FROM regexp_split_to_table(%%s, '') WITH ORDINALITY AS s(c, i))$s$,
    invisible, ws);
  problems text := '';
  found text;
  r record;
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accounts', 'tax_codes', 'business_partners'] LOOP
    EXECUTE format($q$
      SELECT string_agg(%s || ' <- ' || codes, '; ' ORDER BY k)
      FROM (
        SELECT lower(%s) AS k,
               string_agg(%s || ' (id ' || id || ')', ', '
                          ORDER BY code) AS codes
        FROM %I WHERE deleted_at IS NULL
        GROUP BY 1 HAVING count(*) > 1
      ) d $q$, format(shown, 'k'), norm, format(shown, 'code'), t) INTO found;
    IF found IS NOT NULL THEN
      problems := problems || format(E'\n  %s: live codes collide case-insensitively after normalization: %s', t, found);
    END IF;

    EXECUTE format($q$
      SELECT string_agg(%4$s || ' (id ' || id || ')', ', '
                        ORDER BY code)
      FROM %1$I
      WHERE deleted_at IS NULL
        AND (%2$s = '' OR %2$s ~ %3$L) $q$, t, norm, invisible,
      format(shown, 'code'))
      INTO found;
    IF found IS NOT NULL THEN
      problems := problems || format(E'\n  %s: live codes that cannot be normalized automatically (blank, or holding an invisible format / control / default-ignorable / line-separator character): %s', t, found);
    END IF;

    EXECUTE format($q$
      SELECT string_agg(%s || ' (id ' || l.id || ') vs deleted id ' || d.id, ', ')
      FROM %I l JOIN %I d
        ON d.deleted_at IS NOT NULL AND d.code = %s AND l.code <> d.code
      WHERE l.deleted_at IS NULL $q$, format(shown, 'l.code'), t, t,
      replace(norm, 'code', 'l.code'))
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
      RETURNING x.id, n.old_code, n.new_code, %s AS old_shown,
                %s AS new_shown $q$, t, norm, t,
      format(shown, 'n.old_code'), format(shown, 'n.new_code'))
    LOOP
      RAISE NOTICE 'identifier code normalized: % id % : % -> %',
        t, r.id, r.old_shown, r.new_shown;
      -- `prisma migrate deploy` does not print NOTICEs: the durable record of
      -- each auto-fix is this audit row (GET /v1/audit?method=MIGRATION).
      -- audit_log's append-only triggers block only UPDATE / DELETE /
      -- TRUNCATE; the INSERT commits or rolls back with the fix.
      INSERT INTO audit_log (id, method, path, body, status_code, duration_ms, entity_id)
      VALUES (gen_random_uuid()::text, 'MIGRATION',
              '20261005000000_identifier_code_ci_unique',
              jsonb_build_object('table', t, 'id', r.id,
                                 'old', r.old_code, 'new', r.new_code),
              200, 0, r.id);
    END LOOP;

    EXECUTE format($q$
      SELECT string_agg(%s || ' (id ' || id || ')', ', ')
      FROM %I WHERE deleted_at IS NULL AND code <> %s $q$,
      format(shown, 'code'), t, norm)
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
