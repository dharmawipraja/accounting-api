-- Line-immutability trigger: read the parent journal_entries row FOR SHARE.
--
-- The original function (20260926300000_ledger_integrity) read the parent with
-- a plain SELECT, i.e. the statement snapshot. A line INSERT racing a
-- DRAFT->POSTED promotion in another transaction therefore saw the parent as
-- still a draft (the promotion was uncommitted) and slipped a line into what
-- became a posted entry: the FK check only takes FOR KEY SHARE, which does not
-- conflict with the promotion's non-key UPDATE.
--
-- FOR SHARE conflicts with that UPDATE's row lock (and with postDraft's
-- SELECT ... FOR UPDATE), so the line write now waits for the promotion to
-- finish and then re-reads the committed parent (READ COMMITTED re-check):
-- posted by another tx -> rejected. If the line write takes the lock first, the
-- promotion waits for it and postDraft re-reads the draft's lines in its own
-- tx, so the promoted entry includes (and balance-checks) the new line.
-- Rows the SAME transaction already locks (a post inserting lines into the
-- entry it just created/updated) are unaffected — a tx never conflicts with
-- its own locks. Behaviour is otherwise identical to the previous function.
-- CREATE OR REPLACE keeps the existing trigger binding, owner and grants.
CREATE OR REPLACE FUNCTION journal_lines_immutable_trg() RETURNS trigger AS $$
DECLARE
  v_posted timestamp(3);
  v_xid xid8;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT posted_at INTO v_posted FROM journal_entries
      WHERE id = OLD.journal_entry_id FOR SHARE;
    IF v_posted IS NOT NULL THEN
      RAISE EXCEPTION 'journal_lines: lines of posted journal entry % are immutable (% not permitted)',
        OLD.journal_entry_id, TG_OP USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id) THEN
    SELECT posted_at, posted_xid INTO v_posted, v_xid FROM journal_entries
      WHERE id = NEW.journal_entry_id FOR SHARE;
    IF v_posted IS NOT NULL AND v_xid IS DISTINCT FROM pg_current_xact_id() THEN
      RAISE EXCEPTION 'journal_lines: posted journal entry % is immutable (lines cannot be added after posting)',
        NEW.journal_entry_id USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
