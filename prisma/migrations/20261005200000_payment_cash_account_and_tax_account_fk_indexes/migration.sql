-- AUDIT3 iteration-8 (Task 29): index the two FK columns that had none, so an
-- account's referencing rows are found by index (FK RESTRICT checks on an
-- account delete/key change, "which payments / tax codes use this account").
CREATE INDEX "payments_cash_account_id_idx" ON "payments"("cash_account_id");
CREATE INDEX "tax_codes_tax_account_id_idx" ON "tax_codes"("tax_account_id");
