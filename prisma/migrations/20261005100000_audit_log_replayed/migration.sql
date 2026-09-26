-- AUDIT3 iteration-8 (Task 29): an audit row written for an idempotent REPLAY
-- (same Idempotency-Key + request, stored response returned, no new write)
-- carries replayed = true, so it can't be mistaken for a second creation.
-- NULL for every other row (incl. all rows written before this migration).
-- Nullable, no default: adding it is a catalog-only change (no table rewrite)
-- and the append-only trigger on audit_log is unaffected.
ALTER TABLE "audit_log" ADD COLUMN "replayed" BOOLEAN;
