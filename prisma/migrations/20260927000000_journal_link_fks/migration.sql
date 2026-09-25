-- AUDIT3-11: FKs for the journal-entry link columns 20260926300000_ledger_integrity
-- left unconstrained — year_end_closings.closing_entry_id, and the reversal pair
-- journal_entries.reversal_of_id / reversed_by_id (self-references). ON DELETE
-- RESTRICT like every other ledger reference; ON UPDATE CASCADE = Prisma's
-- default, so schema.prisma's relations diff clean.
--
-- The app satisfies these non-deferred FKs by statement order: a reversal
-- INSERTs the reversal entry (reversal_of_id -> the existing original) and only
-- then UPDATEs the original's reversed_by_id; close INSERTs the closing entry
-- before upserting year_end_closings. Adding an FK validates existing rows but
-- updates none, so the posted-entry immutability trigger is not involved.

-- Pre-flight: fail LOUDLY (no silent repair) if existing rows point nowhere.
DO $$
DECLARE
  problems text[] := '{}';
  n bigint;
  ids text;
BEGIN
  -- True counts; the id lists are capped at 20 for readability.
  SELECT count(*) INTO n FROM year_end_closings y
  WHERE y.closing_entry_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.id = y.closing_entry_id);
  IF n > 0 THEN
    SELECT string_agg(fiscal_year::text, ', ') INTO ids FROM (
      SELECT y.fiscal_year FROM year_end_closings y
      WHERE y.closing_entry_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.id = y.closing_entry_id)
      ORDER BY y.fiscal_year LIMIT 20) x;
    problems := problems || format('%s year_end_closings.closing_entry_id orphans (fiscal years: %s)', n, ids);
  END IF;

  SELECT count(*) INTO n FROM journal_entries je
  WHERE je.reversal_of_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM journal_entries o WHERE o.id = je.reversal_of_id);
  IF n > 0 THEN
    SELECT string_agg(id, ', ') INTO ids FROM (
      SELECT je.id FROM journal_entries je
      WHERE je.reversal_of_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM journal_entries o WHERE o.id = je.reversal_of_id)
      ORDER BY je.id LIMIT 20) x;
    problems := problems || format('%s journal_entries.reversal_of_id orphans (entries: %s)', n, ids);
  END IF;

  SELECT count(*) INTO n FROM journal_entries je
  WHERE je.reversed_by_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.id = je.reversed_by_id);
  IF n > 0 THEN
    SELECT string_agg(id, ', ') INTO ids FROM (
      SELECT je.id FROM journal_entries je
      WHERE je.reversed_by_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.id = je.reversed_by_id)
      ORDER BY je.id LIMIT 20) x;
    problems := problems || format('%s journal_entries.reversed_by_id orphans (entries: %s)', n, ids);
  END IF;

  IF array_length(problems, 1) > 0 THEN
    RAISE EXCEPTION 'journal_link_fks migration aborted — existing rows reference missing journal entries: %. Correct the rows, then re-run the migration.',
      array_to_string(problems, '; ');
  END IF;
END $$;

ALTER TABLE "year_end_closings" ADD CONSTRAINT "year_end_closings_closing_entry_id_fkey"
  FOREIGN KEY ("closing_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversal_of_id_fkey"
  FOREIGN KEY ("reversal_of_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversed_by_id_fkey"
  FOREIGN KEY ("reversed_by_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
