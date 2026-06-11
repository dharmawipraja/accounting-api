-- CreateEnum
CREATE TYPE "CloseStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "year_end_closings" (
    "fiscal_year" INTEGER NOT NULL,
    "status" "CloseStatus" NOT NULL,
    "closing_entry_id" TEXT,
    "net_income" DECIMAL(20,4) NOT NULL DEFAULT 0,
    "closed_at" TIMESTAMP(3) NOT NULL,
    "closed_by" TEXT NOT NULL,
    "reopened_at" TIMESTAMP(3),
    "reopened_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "year_end_closings_pkey" PRIMARY KEY ("fiscal_year")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" TEXT,
    "user_role" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "params" JSONB,
    "body" JSONB,
    "status_code" INTEGER NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "ip" TEXT,
    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_timestamp_idx" ON "audit_log"("timestamp");
CREATE INDEX "audit_log_user_id_idx" ON "audit_log"("user_id");

-- DataMigration: Laba Ditahan flows as FINANCING in the cash-flow statement
UPDATE "accounts" SET "cash_flow_category" = 'FINANCING' WHERE "code" = '3-2000';
