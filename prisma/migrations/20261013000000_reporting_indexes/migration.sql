-- Reporting indexes (general ledger at volume). Hand-authored.
--
-- 1) journal_lines (account_id, journal_entry_id) gains trailing (debit, credit)
--    and replaces the 2-column index (same leading columns, so every query the
--    old one served still uses it): the GL / account-balance aggregates over an
--    account's whole history (opening, closing, running balance through a
--    cursor) become index-only on the lines side instead of one random heap
--    fetch per line (EXPLAIN on a 600k-line seed: a 10k-line account read 161
--    index buffers vs 5,993 heap blocks). Key columns, not INCLUDE: Prisma
--    reads INCLUDE columns as key columns, so only this shape round-trips with
--    schema.prisma's @@index([accountId, journalEntryId, debit, credit]).
-- 2) The partial posted-live date index widens to the GL keyset order
--    (date, entry_number, id): the line page's range scan is index-only and
--    already in report order. It supersedes the (date)-only partial index
--    (same predicate, same leading column). Partial: not expressible in
--    schema.prisma (see the JournalEntry comment).
--
-- Plain CREATE INDEX (not CONCURRENTLY: migrations run in a transaction);
-- both tables are append-mostly and the build is a one-off at deploy.

DROP INDEX "journal_lines_account_id_journal_entry_id_idx";
CREATE INDEX "journal_lines_account_id_journal_entry_id_debit_credit_idx"
  ON "journal_lines"("account_id", "journal_entry_id", "debit", "credit");

DROP INDEX "journal_entries_posted_live_date_idx";
CREATE INDEX "journal_entries_posted_live_order_idx"
  ON "journal_entries"("date", "entry_number", "id")
  WHERE "posted_at" IS NOT NULL AND "deleted_at" IS NULL;
