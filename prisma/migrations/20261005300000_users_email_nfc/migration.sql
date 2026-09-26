-- AUDIT3 iteration-8 (Task 29, fix round 1): emails are Unicode NFC.
-- normalizeEmail() (src/users/normalize-email.ts) now NFC-normalizes on every
-- write AND lookup. A user created before that change may have a DECOMPOSED
-- (NFD) email stored (it was only trimmed + lowercased), which an NFC lookup
-- never matches: that user could no longer log in, and scripts/create-admin
-- would create a SECOND user for the same address (users_email_lower_key does
-- not catch it — lower() does not compose).
--
-- All-or-nothing, in one DO block:
--   1. BLOCKING: two rows whose emails are equal once NFC-normalized and
--      lowercased (e.g. 'josé' precomposed and decomposed) → fail listing the
--      ids. Pick the real account, change the other's email (or merge by
--      hand), then `prisma migrate resolve --rolled-back
--      20261005300000_users_email_nfc` and re-run `prisma migrate deploy`.
--   2. Backfill: every other non-NFC email is rewritten to its NFC form (case
--      untouched: stored emails are already lowercased by the app), each
--      recorded as an audit_log row (method 'MIGRATION', path = this
--      migration's name, body {table, id, old, new}, user_id NULL — GET
--      /v1/audit?method=MIGRATION; `prisma migrate deploy` does not print the
--      RAISE NOTICE that repeats it). No rewrite, no row.
-- Tombstoned rows (email '<email>#deleted-<id>') are rewritten too; their
-- unique suffix keeps them collision-free.
--
-- Invariant afterwards: every stored email is NFC and the existing
-- users_email_lower_key on lower(email) is again a complete case-insensitive
-- guard. The CHECK below keeps it that way for any future writer (the app,
-- scripts, hand-written SQL); a violation from the app would surface as the
-- generic 422 constraint backstop. Case is not CHECKed: JS toLowerCase and
-- Postgres lower() can disagree on rare characters, which could reject
-- valid existing rows.
DO $$
DECLARE
  found text;
  r record;
BEGIN
  SELECT string_agg(k || ' <- ' || ids, '; ' ORDER BY k) INTO found
  FROM (
    SELECT lower(normalize(email, NFC)) AS k,
           string_agg(quote_literal(email) || ' (id ' || id || ')', ', '
                      ORDER BY email) AS ids
    FROM users GROUP BY 1 HAVING count(*) > 1
  ) d;
  IF found IS NOT NULL THEN
    RAISE EXCEPTION 'users email NFC normalization aborted: users whose emails are the same address once NFC-normalized: %', found
      USING HINT = 'Keep one account per address: UPDATE users SET email = ''<other>'' WHERE id = ''<id>'' for the rest, then mark this attempt rolled back (prisma migrate resolve --rolled-back 20261005300000_users_email_nfc) and re-run prisma migrate deploy. Nothing was changed by this run.';
  END IF;

  FOR r IN
    UPDATE users u SET email = normalize(n.old_email, NFC)
    FROM (SELECT id, email AS old_email FROM users
          WHERE email IS NOT NFC NORMALIZED) n
    WHERE u.id = n.id
    RETURNING u.id, n.old_email, u.email AS new_email
  LOOP
    RAISE NOTICE 'users email normalized to NFC: id % : % -> %',
      r.id, quote_literal(r.old_email), quote_literal(r.new_email);
    -- `prisma migrate deploy` does not print NOTICEs: the durable record of
    -- each rewrite is this audit row (GET /v1/audit?method=MIGRATION).
    -- audit_log's append-only triggers block only UPDATE / DELETE /
    -- TRUNCATE; the INSERT commits or rolls back with the rewrite.
    INSERT INTO audit_log (id, method, path, body, status_code, duration_ms, entity_id)
    VALUES (gen_random_uuid()::text, 'MIGRATION',
            '20261005300000_users_email_nfc',
            jsonb_build_object('table', 'users', 'id', r.id,
                               'old', r.old_email, 'new', r.new_email),
            200, 0, r.id);
  END LOOP;
END $$;

ALTER TABLE users ADD CONSTRAINT users_email_nfc CHECK (email IS NFC NORMALIZED);
