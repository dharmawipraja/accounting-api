-- Audit #10: a void may be dated later than the document (e.g. when the
-- document's period is closed). voided_on records the void (reversal) date so
-- as-of reports (aging) can tell whether a document/payment was still live on
-- a given day.
ALTER TABLE "sales_invoices" ADD COLUMN "voided_on" DATE;
ALTER TABLE "purchase_bills" ADD COLUMN "voided_on" DATE;
ALTER TABLE "payments" ADD COLUMN "voided_on" DATE;

-- Backfill existing VOID rows: the date of the reversal entry of the document's
-- journal entry, falling back to the document date.
UPDATE "sales_invoices" d
SET "voided_on" = COALESCE(
  (SELECT je."date" FROM "journal_entries" je
   WHERE je."reversal_of_id" = d."journal_entry_id"),
  d."date")
WHERE d."status" = 'VOID';

UPDATE "purchase_bills" d
SET "voided_on" = COALESCE(
  (SELECT je."date" FROM "journal_entries" je
   WHERE je."reversal_of_id" = d."journal_entry_id"),
  d."date")
WHERE d."status" = 'VOID';

UPDATE "payments" d
SET "voided_on" = COALESCE(
  (SELECT je."date" FROM "journal_entries" je
   WHERE je."reversal_of_id" = d."journal_entry_id"),
  d."date")
WHERE d."status" = 'VOID';

-- A document/payment carries a void date iff it is VOID.
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_voided_on_iff_void"
  CHECK (("status" = 'VOID') = ("voided_on" IS NOT NULL));
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_voided_on_iff_void"
  CHECK (("status" = 'VOID') = ("voided_on" IS NOT NULL));
ALTER TABLE "payments" ADD CONSTRAINT "payments_voided_on_iff_void"
  CHECK (("status" = 'VOID') = ("voided_on" IS NOT NULL));
