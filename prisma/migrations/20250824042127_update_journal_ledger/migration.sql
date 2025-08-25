/*
  Warnings:

  - You are about to drop the column `amount` on the `journal_ledgers` table. All the data in the column will be lost.
  - You are about to drop the column `referenceNumber` on the `journal_ledgers` table. All the data in the column will be lost.
  - You are about to drop the column `reportType` on the `journal_ledgers` table. All the data in the column will be lost.
  - You are about to drop the column `transactionType` on the `journal_ledgers` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."journal_ledgers" DROP COLUMN "amount",
DROP COLUMN "referenceNumber",
DROP COLUMN "reportType",
DROP COLUMN "transactionType",
ADD COLUMN     "amountCredit" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "amountDebit" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "credit" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "debit" DECIMAL(10,2) NOT NULL DEFAULT 0;
