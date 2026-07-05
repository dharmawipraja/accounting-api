/*
  Warnings:

  - The primary key for the `idempotency_keys` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - Added the required column `user_id` to the `idempotency_keys` table without a default value. This is not possible if the table is not empty.

*/
-- idempotency_keys is a short-TTL response cache (completed rows purge after
-- 24h). Pre-scoping rows have no user and can never match a (user_id, key)
-- lookup, so clearing them is safe and lets the NOT NULL column add succeed
-- on a non-empty table. Worst case: a retry in flight across the deploy
-- re-executes instead of replaying.
DELETE FROM "idempotency_keys";

-- AlterTable
ALTER TABLE "idempotency_keys" DROP CONSTRAINT "idempotency_keys_pkey",
ADD COLUMN     "user_id" TEXT NOT NULL,
ADD CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("user_id", "key");
