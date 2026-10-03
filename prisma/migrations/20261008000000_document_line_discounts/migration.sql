-- Per-line discounts on sales invoices and purchase bills, applied BEFORE tax.
--
-- A line stores what the user entered (discount_percent, NULL for a fixed or
-- no discount) and the resolved discount_amount (default 0). The line
-- `amount` is the NET (discounted) amount = round(quantity * unit_price, 4)
-- - discount_amount: the tax base (DPP) and the revenue/expense posting.
-- The document's discount_total is the sum of its lines' discount_amount.
-- Existing rows get discount_amount = 0 / discount_total = 0, so their
-- amounts are unchanged and every CHECK below already holds for them
-- (quantity/unit_price >= 0 is enforced by *_lines_nonnegative).
-- Postgres evaluates CHECKs in name order: *_valid_discount sorts after
-- *_lines_nonnegative, so a negative quantity/price still reports that one.

ALTER TABLE "sales_invoice_lines"
  ADD COLUMN "discount_percent" DECIMAL(7,4),
  ADD COLUMN "discount_amount" DECIMAL(20,4) NOT NULL DEFAULT 0;
ALTER TABLE "purchase_bill_lines"
  ADD COLUMN "discount_percent" DECIMAL(7,4),
  ADD COLUMN "discount_amount" DECIMAL(20,4) NOT NULL DEFAULT 0;
ALTER TABLE "sales_invoices"
  ADD COLUMN "discount_total" DECIMAL(20,4) NOT NULL DEFAULT 0;
ALTER TABLE "purchase_bills"
  ADD COLUMN "discount_total" DECIMAL(20,4) NOT NULL DEFAULT 0;

ALTER TABLE "sales_invoice_lines"
  ADD CONSTRAINT "sales_invoice_lines_valid_discount" CHECK (
    discount_amount >= 0
    AND discount_amount <= round(quantity * unit_price, 4)
    AND amount >= 0
    AND (discount_percent IS NULL OR (discount_percent >= 0 AND discount_percent <= 100))
  );
ALTER TABLE "purchase_bill_lines"
  ADD CONSTRAINT "purchase_bill_lines_valid_discount" CHECK (
    discount_amount >= 0
    AND discount_amount <= round(quantity * unit_price, 4)
    AND amount >= 0
    AND (discount_percent IS NULL OR (discount_percent >= 0 AND discount_percent <= 100))
  );
ALTER TABLE "sales_invoices"
  ADD CONSTRAINT "sales_invoices_discount_total_nonnegative" CHECK (discount_total >= 0);
ALTER TABLE "purchase_bills"
  ADD CONSTRAINT "purchase_bills_discount_total_nonnegative" CHECK (discount_total >= 0);
