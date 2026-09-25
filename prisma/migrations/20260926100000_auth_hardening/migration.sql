-- AUDIT3-7: auth & audit hardening.

-- 1) Emails are case-insensitive identifiers. Normalize existing rows to
--    lower(trim(email)) and back it with a functional unique index. Fail LOUDLY
--    (no silent merge) if two live-or-tombstoned rows collide once normalized —
--    an operator must resolve those accounts by hand first.
DO $$
DECLARE
  dups text;
BEGIN
  SELECT string_agg(norm, ', ' ORDER BY norm) INTO dups
  FROM (
    SELECT lower(trim(email)) AS norm
    FROM users
    GROUP BY lower(trim(email))
    HAVING count(*) > 1
  ) d;
  IF dups IS NOT NULL THEN
    RAISE EXCEPTION 'users.email normalization aborted: case/whitespace-insensitive duplicate emails exist: %. Merge, rename or tombstone the duplicate accounts, then re-run the migration.', dups;
  END IF;
END $$;

UPDATE users SET email = lower(trim(email)) WHERE email <> lower(trim(email));

-- Not expressible in schema.prisma (expression index); users_email_key stays
-- as the Prisma-visible @@unique([email]).
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

-- 2) Audit correlation: the request's trace id (X-Request-Id / error traceId)
--    and the created/affected entity id (response body `id`, when present).
ALTER TABLE audit_log ADD COLUMN request_id TEXT;
ALTER TABLE audit_log ADD COLUMN entity_id TEXT;
CREATE INDEX audit_log_request_id_idx ON audit_log (request_id);
CREATE INDEX audit_log_entity_id_idx ON audit_log (entity_id);

-- 3) Append-only also against TRUNCATE (the row-level UPDATE/DELETE trigger
--    from 20260617000001 does not fire for TRUNCATE). Statement-level trigger.
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
