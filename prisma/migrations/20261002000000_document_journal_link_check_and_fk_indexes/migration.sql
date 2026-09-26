-- AUDIT3 iteration-2 (Task 16): posted documents at DB level + cheap FK indexes.
--
-- 1. A sales invoice / purchase bill / payment carries a journal entry exactly
--    when it is not a DRAFT. Every app path satisfies this: create inserts a
--    DRAFT with journal_entry_id NULL; post sets status = 'POSTED' and
--    journal_entry_id in the same UPDATE; void sets only status = 'VOID' (+
--    voided_on) and KEEPS journal_entry_id (the reversal links back to it via
--    journal_entries.reversal_of_id); only POSTED rows can be voided; a draft
--    soft-delete sets deleted_at only (the row stays DRAFT, journal_entry_id
--    NULL). Soft-deleted rows are checked too — none can violate it.

-- Pre-flight: fail LOUDLY (no silent repair) if existing rows break the rule.
DO $$
DECLARE
  problems text[] := '{}';
  t text;
  n bigint;
  ids text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sales_invoices', 'purchase_bills', 'payments'] LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I WHERE (status = ''DRAFT'') <> (journal_entry_id IS NULL)', t)
      INTO n;
    IF n > 0 THEN
      -- True count; the id list is capped at 20 for readability.
      EXECUTE format(
        'SELECT string_agg(id || '' ('' || status || '')'', '', '') FROM (
           SELECT id, status::text AS status FROM %I
           WHERE (status = ''DRAFT'') <> (journal_entry_id IS NULL)
           ORDER BY id LIMIT 20) x', t)
        INTO ids;
      problems := problems || format('%s %s rows (%s)', n, t, ids);
    END IF;
  END LOOP;
  IF array_length(problems, 1) > 0 THEN
    RAISE EXCEPTION 'document_journal_link_check migration aborted — documents whose journal_entry_id does not match their status (DRAFT must have none, POSTED/VOID must have one): %. Correct the rows, then re-run the migration.',
      array_to_string(problems, '; ');
  END IF;
END $$;

ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_journal_entry_iff_not_draft"
  CHECK (("status" = 'DRAFT') = ("journal_entry_id" IS NULL));
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_journal_entry_iff_not_draft"
  CHECK (("status" = 'DRAFT') = ("journal_entry_id" IS NULL));
ALTER TABLE "payments" ADD CONSTRAINT "payments_journal_entry_iff_not_draft"
  CHECK (("status" = 'DRAFT') = ("journal_entry_id" IS NULL));

-- 2. Index the FK columns that ON DELETE RESTRICT checks and joins probe
--    (journal_entries.period_id / reversed_by_id, the documents'
--    journal_entry_id, year_end_closings.closing_entry_id). None existed.
--    Plain CREATE INDEX (Prisma runs each migration in a transaction, so not
--    CONCURRENTLY); these tables are small in this deployment profile.
CREATE INDEX "journal_entries_period_id_idx" ON "journal_entries"("period_id");
CREATE INDEX "journal_entries_reversed_by_id_idx" ON "journal_entries"("reversed_by_id");
CREATE INDEX "sales_invoices_journal_entry_id_idx" ON "sales_invoices"("journal_entry_id");
CREATE INDEX "purchase_bills_journal_entry_id_idx" ON "purchase_bills"("journal_entry_id");
CREATE INDEX "payments_journal_entry_id_idx" ON "payments"("journal_entry_id");
CREATE INDEX "year_end_closings_closing_entry_id_idx" ON "year_end_closings"("closing_entry_id");
