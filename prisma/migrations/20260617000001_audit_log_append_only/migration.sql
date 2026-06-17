-- Enforce append-only on audit_log at the database, independent of DB role
-- (the app/migrate role owns the table and would bypass any REVOKE). Blocks
-- UPDATE/DELETE for everyone; INSERT/SELECT are unaffected.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_mutate
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
