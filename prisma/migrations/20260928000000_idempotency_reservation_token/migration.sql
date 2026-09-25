-- Per-reservation fencing token. reserve() writes a fresh token on every
-- insert (including a stale reclaim's re-insert, which rotates it), the
-- request carries it in its ALS idempotency context, and the in-tx committed
-- mark / complete() / release() / markCommitted() all match on it. So an
-- attempt whose reservation was reclaimed by a newer one can never mark,
-- record over or release the newer owner's row: its in-tx mark updates 0 rows
-- and the business transaction rolls back with a 409.
ALTER TABLE "idempotency_keys"
  ADD COLUMN "reservation_token" UUID NOT NULL DEFAULT gen_random_uuid();
