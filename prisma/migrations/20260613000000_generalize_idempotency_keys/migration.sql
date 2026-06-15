-- Generalize idempotency_keys from the journal-specific shape (endpoint,
-- result_entry_id) to an entity-agnostic response snapshot. Idempotency rows are
-- transient; clearing them on migrate is safe and lets us add NOT NULL columns.
DELETE FROM "idempotency_keys";

ALTER TABLE "idempotency_keys" DROP COLUMN "endpoint";
ALTER TABLE "idempotency_keys" DROP COLUMN "result_entry_id";

ALTER TABLE "idempotency_keys" ADD COLUMN "method" TEXT NOT NULL;
ALTER TABLE "idempotency_keys" ADD COLUMN "path" TEXT NOT NULL;
ALTER TABLE "idempotency_keys" ADD COLUMN "request_hash" TEXT NOT NULL;
ALTER TABLE "idempotency_keys" ADD COLUMN "response" JSONB;
ALTER TABLE "idempotency_keys" ADD COLUMN "http_status" INTEGER;
ALTER TABLE "idempotency_keys" ADD COLUMN "completed_at" TIMESTAMP(3);
