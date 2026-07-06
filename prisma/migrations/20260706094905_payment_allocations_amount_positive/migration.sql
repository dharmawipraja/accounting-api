-- DB-level backstop matching journal_lines' CHECK: app code already rejects
-- non-positive allocations, but a raw-SQL script or future write path must
-- not be able to corrupt amountPaid/outstanding math silently.
ALTER TABLE "payment_allocations"
  ADD CONSTRAINT "payment_allocations_amount_positive" CHECK ("amount" > 0);
