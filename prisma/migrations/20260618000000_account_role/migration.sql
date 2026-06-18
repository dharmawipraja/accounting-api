-- AccountRole: explicit system-account roles replacing by-code coupling.
CREATE TYPE "AccountRole" AS ENUM (
  'CASH', 'AR_CONTROL', 'AP_CONTROL', 'RETAINED_EARNINGS', 'OPENING_BALANCE_EQUITY', 'TAX_EXPENSE'
);

ALTER TABLE "accounts" ADD COLUMN "role" "AccountRole";

-- At most one account per singleton role; CASH may be held by many accounts.
CREATE UNIQUE INDEX "accounts_singleton_role"
  ON "accounts" ("role")
  WHERE "role" IS NOT NULL AND "role" <> 'CASH';

-- Behavior-preserving backfill of the seeded chart (production data; no-op on a fresh DB).
UPDATE "accounts" SET "role" = 'CASH'                   WHERE "code" IN ('1-1000', '1-1100');
UPDATE "accounts" SET "role" = 'AR_CONTROL'             WHERE "code" = '1-1200';
UPDATE "accounts" SET "role" = 'AP_CONTROL'             WHERE "code" = '2-1000';
UPDATE "accounts" SET "role" = 'RETAINED_EARNINGS'      WHERE "code" = '3-2000';
UPDATE "accounts" SET "role" = 'OPENING_BALANCE_EQUITY' WHERE "code" = '3-9000';
UPDATE "accounts" SET "role" = 'TAX_EXPENSE'            WHERE "code" = '5-9000';
