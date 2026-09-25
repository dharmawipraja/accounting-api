-- Set inside the business transaction of an idempotent request (the last
-- statement before COMMIT), so it is durable iff the write committed. A row
-- with committed_at set is never released or reclaimed: a same-key retry gets
-- 409 instead of re-executing a committed write.
ALTER TABLE "idempotency_keys" ADD COLUMN "committed_at" TIMESTAMP(3);
