-- Enable trigram fuzzy/substring search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram indexes accelerate BOTH ILIKE '%...%' and similarity() searches.
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
