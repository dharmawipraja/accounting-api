-- Corrective forward migration: restore the pg_trgm GIN indexes that the
-- prior migration 20260618182249_remove_trigram_indexes dropped.
--
-- That drop migration was an erroneous `prisma migrate dev` drift artifact:
-- pg_trgm GIN indexes cannot be expressed in schema.prisma, so `migrate dev`
-- sees them as drift and proposes dropping them. These indexes back the
-- fuzzy/substring `?q=` search (src/common/search/trigram-search.ts) on
-- partners, sales invoices, purchase bills, payments, and journal entries.
--
-- Idempotent (IF NOT EXISTS) so it is safe regardless of current DB state.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "business_partners_name_trgm"  ON "business_partners" USING gin ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "business_partners_code_trgm"  ON "business_partners" USING gin ("code" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "business_partners_npwp_trgm"  ON "business_partners" USING gin ("npwp" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "business_partners_email_trgm" ON "business_partners" USING gin ("email" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "sales_invoices_invoice_ref_trgm"  ON "sales_invoices" USING gin ("invoice_ref" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "sales_invoices_description_trgm"  ON "sales_invoices" USING gin ("description" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "purchase_bills_bill_ref_trgm"          ON "purchase_bills" USING gin ("bill_ref" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "purchase_bills_vendor_invoice_no_trgm" ON "purchase_bills" USING gin ("vendor_invoice_no" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "purchase_bills_description_trgm"       ON "purchase_bills" USING gin ("description" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "payments_ref_trgm"         ON "payments" USING gin ("ref" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "payments_description_trgm" ON "payments" USING gin ("description" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "journal_entries_entry_ref_trgm"   ON "journal_entries" USING gin ("entry_ref" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "journal_entries_description_trgm" ON "journal_entries" USING gin ("description" gin_trgm_ops);
