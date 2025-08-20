/*
  Warnings:

  - Added the required column `createdBy` to the `users` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "public"."accounts_detail" ADD COLUMN     "accumulationAmountCredit" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "accumulationAmountDebit" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "initialAmountCredit" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "initialAmountDebit" DECIMAL(10,2) NOT NULL DEFAULT 0,
ALTER COLUMN "amountCredit" SET DEFAULT 0,
ALTER COLUMN "amountDebit" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."accounts_general" ADD COLUMN     "accumulationAmountCredit" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "accumulationAmountDebit" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "initialAmountCredit" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "initialAmountDebit" DECIMAL(10,2) NOT NULL DEFAULT 0,
ALTER COLUMN "amountCredit" SET DEFAULT 0,
ALTER COLUMN "amountDebit" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."users" ADD COLUMN     "createdBy" TEXT NOT NULL,
ADD COLUMN     "forceLogout" BOOLEAN NOT NULL DEFAULT false;
