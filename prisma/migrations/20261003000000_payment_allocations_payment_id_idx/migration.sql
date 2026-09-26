-- payment_allocations(payment_id) had no index: every per-payment allocation
-- read (payment detail/list includes, void) and the
-- ON DELETE CASCADE from payments seq-scanned the table. Additive, no data
-- precondition — cannot abort on legacy data.
CREATE INDEX "payment_allocations_payment_id_idx" ON "payment_allocations"("payment_id");
