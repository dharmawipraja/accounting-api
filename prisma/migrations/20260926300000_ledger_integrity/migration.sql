-- AUDIT3-9: database-level defense in depth for the ledger.
--
-- Until now Postgres enforced only per-line one-sidedness (journal_lines_one_sided);
-- balance, posted-entry immutability and referential integrity were application
-- conventions. This migration makes them database invariants so a raw-SQL
-- script, a future write path or an operator mistake cannot silently corrupt
-- the books. None of these should ever fire from application code: if one does
-- it is a bug and surfaces as a generic 500 (INTERNAL_ERROR, logged).
--
-- Invariants added (see docs/runbooks/database-and-migrations.md):
--   1. Posted entries balance: SUM(debit) = SUM(credit) and >= 2 lines
--      (deferred constraint triggers, checked at COMMIT).
--   2. Posted entries are immutable: only status POSTED->REVERSED (+ the
--      reversed_by_id link, + updated_at) may change; no DELETE, no soft delete;
--      their lines cannot be updated/deleted, and lines may be inserted into a
--      posted entry only by the transaction that created it.
--   3. TRUNCATE is refused on the financial-history tables.
--   4. CHECKs: payment amount > 0, allocation has exactly one target,
--      0 <= amount_paid <= total, doc-line quantity/unit_price >= 0, period
--      start <= end and no overlapping periods, a non-DRAFT entry carries its
--      number/fiscal year/period/posted_at.
--   5. FKs ON DELETE RESTRICT on every ledger/document reference; journal_lines
--      no longer cascade-delete with their entry.
--   6. Supporting indexes.
--
-- Restore note: pg_dump emits triggers and FKs in the post-data section, so a
-- full pg_restore loads data before these exist. A --data-only restore into an
-- existing schema needs --disable-triggers.

-- ---------------------------------------------------------------------------
-- 0) Pre-flight: fail LOUDLY (no silent repair) if existing data already
--    violates an invariant. An operator must correct the rows, then re-run.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  problems text[] := '{}';
  n bigint;
  ids text;
BEGIN
  SELECT count(*), string_agg(id, ', ') INTO n, ids FROM (
    SELECT je.id FROM journal_entries je
    LEFT JOIN journal_lines jl ON jl.journal_entry_id = je.id
    WHERE je.posted_at IS NOT NULL
    GROUP BY je.id
    HAVING count(jl.id) < 2 OR COALESCE(SUM(jl.debit), 0) <> COALESCE(SUM(jl.credit), 0)
    LIMIT 20) x;
  IF n > 0 THEN problems := problems || format('unbalanced/short posted journal entries: %s', ids); END IF;

  SELECT count(*) INTO n FROM journal_entries
  WHERE NOT ((status = 'DRAFT' AND posted_at IS NULL)
          OR (status <> 'DRAFT' AND entry_number IS NOT NULL AND fiscal_year IS NOT NULL
              AND period_id IS NOT NULL AND posted_at IS NOT NULL));
  IF n > 0 THEN problems := problems || format('%s journal entries with inconsistent status/posted fields', n); END IF;

  SELECT count(*) INTO n FROM journal_entries WHERE posted_at IS NOT NULL AND deleted_at IS NOT NULL;
  IF n > 0 THEN problems := problems || format('%s soft-deleted posted journal entries', n); END IF;

  SELECT count(*) INTO n FROM payments WHERE amount <= 0;
  IF n > 0 THEN problems := problems || format('%s payments with amount <= 0', n); END IF;
  SELECT count(*) INTO n FROM payment_allocations WHERE num_nonnulls(sales_invoice_id, purchase_bill_id) <> 1;
  IF n > 0 THEN problems := problems || format('%s payment allocations without exactly one target', n); END IF;
  SELECT count(*) INTO n FROM sales_invoices WHERE amount_paid < 0 OR amount_paid > total;
  IF n > 0 THEN problems := problems || format('%s sales invoices with amount_paid outside [0, total]', n); END IF;
  SELECT count(*) INTO n FROM purchase_bills WHERE amount_paid < 0 OR amount_paid > total;
  IF n > 0 THEN problems := problems || format('%s purchase bills with amount_paid outside [0, total]', n); END IF;
  SELECT count(*) INTO n FROM sales_invoice_lines WHERE quantity < 0 OR unit_price < 0;
  IF n > 0 THEN problems := problems || format('%s sales invoice lines with negative quantity/unit_price', n); END IF;
  SELECT count(*) INTO n FROM purchase_bill_lines WHERE quantity < 0 OR unit_price < 0;
  IF n > 0 THEN problems := problems || format('%s purchase bill lines with negative quantity/unit_price', n); END IF;
  SELECT count(*) INTO n FROM accounting_periods WHERE start_date > end_date;
  IF n > 0 THEN problems := problems || format('%s accounting periods with start_date > end_date', n); END IF;
  SELECT count(*), string_agg(a.name || '/' || b.name, ', ') INTO n, ids FROM accounting_periods a
  JOIN accounting_periods b ON a.id < b.id
   AND daterange(a.start_date, a.end_date, '[]') && daterange(b.start_date, b.end_date, '[]');
  IF n > 0 THEN problems := problems || format('overlapping accounting periods: %s', ids); END IF;

  -- Orphaned references (the new FKs).
  SELECT count(*) INTO n FROM journal_lines x WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = x.account_id);
  IF n > 0 THEN problems := problems || format('%s journal_lines.account_id orphans', n); END IF;
  SELECT count(*) INTO n FROM journal_entries x WHERE x.period_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM accounting_periods p WHERE p.id = x.period_id);
  IF n > 0 THEN problems := problems || format('%s journal_entries.period_id orphans', n); END IF;
  SELECT count(*) INTO n FROM sales_invoices x WHERE NOT EXISTS (SELECT 1 FROM business_partners b WHERE b.id = x.partner_id);
  IF n > 0 THEN problems := problems || format('%s sales_invoices.partner_id orphans', n); END IF;
  SELECT count(*) INTO n FROM purchase_bills x WHERE NOT EXISTS (SELECT 1 FROM business_partners b WHERE b.id = x.partner_id);
  IF n > 0 THEN problems := problems || format('%s purchase_bills.partner_id orphans', n); END IF;
  SELECT count(*) INTO n FROM payments x WHERE NOT EXISTS (SELECT 1 FROM business_partners b WHERE b.id = x.partner_id);
  IF n > 0 THEN problems := problems || format('%s payments.partner_id orphans', n); END IF;
  SELECT count(*) INTO n FROM sales_invoice_lines x WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = x.account_id);
  IF n > 0 THEN problems := problems || format('%s sales_invoice_lines.account_id orphans', n); END IF;
  SELECT count(*) INTO n FROM purchase_bill_lines x WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = x.account_id);
  IF n > 0 THEN problems := problems || format('%s purchase_bill_lines.account_id orphans', n); END IF;
  SELECT count(*) INTO n FROM payments x WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = x.cash_account_id);
  IF n > 0 THEN problems := problems || format('%s payments.cash_account_id orphans', n); END IF;
  SELECT count(*) INTO n FROM payment_allocations x WHERE x.sales_invoice_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sales_invoices s WHERE s.id = x.sales_invoice_id);
  IF n > 0 THEN problems := problems || format('%s payment_allocations.sales_invoice_id orphans', n); END IF;
  SELECT count(*) INTO n FROM payment_allocations x WHERE x.purchase_bill_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM purchase_bills s WHERE s.id = x.purchase_bill_id);
  IF n > 0 THEN problems := problems || format('%s payment_allocations.purchase_bill_id orphans', n); END IF;
  SELECT count(*) INTO n FROM (
    SELECT journal_entry_id FROM sales_invoices UNION ALL
    SELECT journal_entry_id FROM purchase_bills UNION ALL
    SELECT journal_entry_id FROM payments) x
  WHERE x.journal_entry_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.id = x.journal_entry_id);
  IF n > 0 THEN problems := problems || format('%s document journal_entry_id orphans', n); END IF;
  SELECT count(*) INTO n FROM tax_codes x WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = x.tax_account_id);
  IF n > 0 THEN problems := problems || format('%s tax_codes.tax_account_id orphans', n); END IF;

  IF array_length(problems, 1) > 0 THEN
    RAISE EXCEPTION 'ledger_integrity migration aborted — existing data violates new invariants: %. Correct the rows, then re-run the migration.',
      array_to_string(problems, '; ');
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1) CHECK constraints
-- ---------------------------------------------------------------------------
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "payment_allocations_one_target"
  CHECK (num_nonnulls("sales_invoice_id", "purchase_bill_id") = 1);
ALTER TABLE "sales_invoices"
  ADD CONSTRAINT "sales_invoices_amount_paid_range"
  CHECK ("amount_paid" >= 0 AND "amount_paid" <= "total");
ALTER TABLE "purchase_bills"
  ADD CONSTRAINT "purchase_bills_amount_paid_range"
  CHECK ("amount_paid" >= 0 AND "amount_paid" <= "total");
ALTER TABLE "sales_invoice_lines"
  ADD CONSTRAINT "sales_invoice_lines_nonnegative"
  CHECK ("quantity" >= 0 AND "unit_price" >= 0);
ALTER TABLE "purchase_bill_lines"
  ADD CONSTRAINT "purchase_bill_lines_nonnegative"
  CHECK ("quantity" >= 0 AND "unit_price" >= 0);
-- A DRAFT has no posting stamp; a POSTED/REVERSED entry has all of it.
ALTER TABLE "journal_entries"
  ADD CONSTRAINT "journal_entries_posted_complete"
  CHECK (("status" = 'DRAFT' AND "posted_at" IS NULL)
      OR ("status" <> 'DRAFT' AND "entry_number" IS NOT NULL AND "fiscal_year" IS NOT NULL
          AND "period_id" IS NOT NULL AND "posted_at" IS NOT NULL));

-- Periods: ordered and non-overlapping (a date resolves to at most one period).
-- btree_gist ships with the official postgres image (contrib) and is a trusted
-- extension; migrations run as the database owner.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "accounting_periods"
  ADD CONSTRAINT "accounting_periods_dates_ordered" CHECK ("start_date" <= "end_date");
ALTER TABLE "accounting_periods"
  ADD CONSTRAINT "accounting_periods_no_overlap"
  EXCLUDE USING gist (daterange("start_date", "end_date", '[]') WITH &&);

-- ---------------------------------------------------------------------------
-- 2) Foreign keys (ON DELETE RESTRICT; ON UPDATE CASCADE = Prisma's default,
--    so schema.prisma's relations diff clean). Accounts/partners are only ever
--    soft-deleted (tombstoned rows remain), so RESTRICT never blocks the app.
-- ---------------------------------------------------------------------------
ALTER TABLE "journal_lines" DROP CONSTRAINT "journal_lines_journal_entry_id_fkey";
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_entry_id_fkey"
  FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_period_id_fkey"
  FOREIGN KEY ("period_id") REFERENCES "accounting_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_partner_id_fkey"
  FOREIGN KEY ("partner_id") REFERENCES "business_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_journal_entry_id_fkey"
  FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_partner_id_fkey"
  FOREIGN KEY ("partner_id") REFERENCES "business_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_journal_entry_id_fkey"
  FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "purchase_bill_lines" ADD CONSTRAINT "purchase_bill_lines_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payments" ADD CONSTRAINT "payments_partner_id_fkey"
  FOREIGN KEY ("partner_id") REFERENCES "business_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_cash_account_id_fkey"
  FOREIGN KEY ("cash_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payments" ADD CONSTRAINT "payments_journal_entry_id_fkey"
  FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_sales_invoice_id_fkey"
  FOREIGN KEY ("sales_invoice_id") REFERENCES "sales_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_purchase_bill_id_fkey"
  FOREIGN KEY ("purchase_bill_id") REFERENCES "purchase_bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tax_codes" ADD CONSTRAINT "tax_codes_tax_account_id_fkey"
  FOREIGN KEY ("tax_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3) Indexes
-- ---------------------------------------------------------------------------
-- (account_id, journal_entry_id) supersedes the single-column account_id index.
DROP INDEX "journal_lines_account_id_idx";
CREATE INDEX "journal_lines_account_id_journal_entry_id_idx" ON "journal_lines"("account_id", "journal_entry_id");
-- Partial index: not expressible in schema.prisma (see the JournalEntry comment).
CREATE INDEX "journal_entries_posted_live_date_idx" ON "journal_entries"("date")
  WHERE "posted_at" IS NOT NULL AND "deleted_at" IS NULL;
CREATE INDEX "sales_invoices_status_date_idx" ON "sales_invoices"("status", "date");
CREATE INDEX "purchase_bills_status_date_idx" ON "purchase_bills"("status", "date");
-- FK-side indexes for the new RESTRICT checks on account/entry deletes.
CREATE INDEX "sales_invoice_lines_account_id_idx" ON "sales_invoice_lines"("account_id");
CREATE INDEX "purchase_bill_lines_account_id_idx" ON "purchase_bill_lines"("account_id");

-- ---------------------------------------------------------------------------
-- 4) Balance: deferred constraint triggers (checked at COMMIT, so a posted
--    entry and its lines may be written by separate statements in one tx).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_assert_entry_balanced(p_entry_id text) RETURNS void AS $$
DECLARE
  v_posted timestamp(3);
  v_lines bigint;
  v_debit numeric;
  v_credit numeric;
BEGIN
  SELECT posted_at INTO v_posted FROM journal_entries WHERE id = p_entry_id;
  IF NOT FOUND OR v_posted IS NULL THEN
    RETURN; -- gone, or a DRAFT (drafts are checked by the app at post time)
  END IF;
  SELECT count(*), COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO v_lines, v_debit, v_credit
    FROM journal_lines WHERE journal_entry_id = p_entry_id;
  IF v_lines < 2 THEN
    RAISE EXCEPTION 'journal_entry_balanced: posted journal entry % must have at least 2 lines (has %)',
      p_entry_id, v_lines USING ERRCODE = 'check_violation';
  END IF;
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'journal_entry_balanced: posted journal entry % is unbalanced (debit %, credit %)',
      p_entry_id, v_debit, v_credit USING ERRCODE = 'check_violation';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION journal_lines_balance_trg() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM ledger_assert_entry_balanced(OLD.journal_entry_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND (TG_OP = 'INSERT' OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id) THEN
    PERFORM ledger_assert_entry_balanced(NEW.journal_entry_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION journal_entries_balance_trg() RETURNS trigger AS $$
BEGIN
  PERFORM ledger_assert_entry_balanced(NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_lines_balance_trg();

-- Covers a posted entry committed with no lines, and the DRAFT->POSTED flip.
CREATE CONSTRAINT TRIGGER journal_entries_balanced
  AFTER INSERT OR UPDATE OF posted_at, status ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entries_balance_trg();

-- ---------------------------------------------------------------------------
-- 5) Posted-entry immutability
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION journal_entries_immutable_trg() RETURNS trigger AS $$
DECLARE
  masked journal_entries;
BEGIN
  IF OLD.posted_at IS NULL THEN
    RETURN COALESCE(NEW, OLD); -- DRAFTs are mutable (and soft-deletable)
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'journal_entries: posted journal entry % is immutable (DELETE not permitted)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- The only legal change to a posted entry is the reversal link-up
  -- (PostingService.reverseInTx): status POSTED->REVERSED + reversed_by_id
  -- NULL->reversal id; Prisma's @updatedAt may bump updated_at.
  masked := NEW;
  masked.status := OLD.status;
  masked.reversed_by_id := OLD.reversed_by_id;
  masked.updated_at := OLD.updated_at;
  IF masked IS DISTINCT FROM OLD
     OR (NEW.status IS DISTINCT FROM OLD.status
         AND NOT (OLD.status = 'POSTED' AND NEW.status = 'REVERSED'))
     OR (NEW.reversed_by_id IS DISTINCT FROM OLD.reversed_by_id
         AND NOT (OLD.reversed_by_id IS NULL AND NEW.status = 'REVERSED')) THEN
    RAISE EXCEPTION 'journal_entries: posted journal entry % is immutable (only POSTED->REVERSED is permitted)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entries_immutable
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entries_immutable_trg();

-- Lines of a posted entry: no UPDATE/DELETE; INSERT only by the transaction
-- that inserted the posted parent (the direct/document/reversal/closing posts
-- write entry + lines in one tx via a nested create). A parent row's xmin is
-- the xid of the transaction that last wrote it; the posting paths never
-- write lines after flipping an existing DRAFT to POSTED (postDraft promotes
-- the draft's existing lines untouched).
CREATE OR REPLACE FUNCTION journal_lines_immutable_trg() RETURNS trigger AS $$
DECLARE
  v_posted timestamp(3);
  v_xmin xid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT posted_at INTO v_posted FROM journal_entries WHERE id = OLD.journal_entry_id;
    IF v_posted IS NOT NULL THEN
      RAISE EXCEPTION 'journal_lines: lines of posted journal entry % are immutable (% not permitted)',
        OLD.journal_entry_id, TG_OP USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id) THEN
    SELECT posted_at, xmin INTO v_posted, v_xmin FROM journal_entries WHERE id = NEW.journal_entry_id;
    IF v_posted IS NOT NULL AND v_xmin IS DISTINCT FROM pg_current_xact_id()::xid THEN
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

CREATE TRIGGER journal_lines_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_lines_immutable_trg();

-- ---------------------------------------------------------------------------
-- 6) No TRUNCATE of financial history (row triggers do not fire for TRUNCATE).
--    audit_log already has its own (20260926100000_auth_hardening).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '%: TRUNCATE is not permitted on financial history', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER journal_lines_no_truncate BEFORE TRUNCATE ON journal_lines
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER sales_invoices_no_truncate BEFORE TRUNCATE ON sales_invoices
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER sales_invoice_lines_no_truncate BEFORE TRUNCATE ON sales_invoice_lines
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER purchase_bills_no_truncate BEFORE TRUNCATE ON purchase_bills
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER purchase_bill_lines_no_truncate BEFORE TRUNCATE ON purchase_bill_lines
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER payments_no_truncate BEFORE TRUNCATE ON payments
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
CREATE TRIGGER payment_allocations_no_truncate BEFORE TRUNCATE ON payment_allocations
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate();
