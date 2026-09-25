-- Least-privilege runtime role for the API: `accounting_app`.
--
-- Idempotent — safe to run on every deploy. Run it as the schema OWNER (the
-- role `prisma migrate deploy` connects as), because GRANT on a table and
-- ALTER DEFAULT PRIVILEGES (which targets the *current* role's future objects)
-- both need the owner. The password is read from the session setting
-- `accounting.app_db_password` (set by the caller from APP_DB_PASSWORD) so it is
-- never hard-coded and never appears in this file or in statement text.
--
-- Callers: scripts/db/ensure-app-role.js (migrate service, after
-- `prisma migrate deploy`) and scripts/db/initdb/10-accounting-app-role.sh
-- (postgres docker-entrypoint, fresh volume only).
--
-- Result: LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, owns nothing;
-- SELECT/INSERT/UPDATE/DELETE on every table in `public` (now and future),
-- USAGE/SELECT/UPDATE on sequences; no TRUNCATE, no DDL (no CREATE on schema),
-- no access to _prisma_migrations, and INSERT/SELECT only on the append-only
-- audit_log.

DO $$
DECLARE
  pw text := current_setting('accounting.app_db_password', true);
BEGIN
  IF pw IS NULL OR pw = '' THEN
    RAISE EXCEPTION 'accounting.app_db_password is not set (APP_DB_PASSWORD is required)';
  END IF;
  -- The dynamic statement text carries the password, and Postgres puts a
  -- failing EXECUTE's full statement in the error CONTEXT (client error and
  -- server log). Re-raise any failure with only its SQLSTATE so the password
  -- can never surface.
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'accounting_app') THEN
      EXECUTE format(
        'CREATE ROLE accounting_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
        pw);
    ELSE
      -- Re-assert attributes and (re)set the password: rotating APP_DB_PASSWORD
      -- and redeploying is the rotation procedure.
      EXECUTE format(
        'ALTER ROLE accounting_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
        pw);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'accounting_app role create/alter failed: %', SQLSTATE;
  END;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO accounting_app', current_database());
END
$$;

-- Drop the password from the session as soon as it has been used.
RESET accounting.app_db_password;

GRANT USAGE ON SCHEMA public TO accounting_app;
REVOKE CREATE ON SCHEMA public FROM accounting_app;

-- Existing objects.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO accounting_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO accounting_app;

-- Future objects created by the owner (i.e. by later migrations).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO accounting_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO accounting_app;

-- Tighten below plain DML where the app never needs it.
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON TABLE public._prisma_migrations FROM accounting_app;
  END IF;
  IF to_regclass('public.audit_log') IS NOT NULL THEN
    REVOKE UPDATE, DELETE ON TABLE public.audit_log FROM accounting_app;
  END IF;
END
$$;
