/*
  Warnings:

  - You are about to drop the column `accountGeneralId` on the `accounts_detail` table. All the data in the column will be lost.
  - You are about to drop the column `accountDetailId` on the `ledgers` table. All the data in the column will be lost.
  - You are about to drop the column `accountGeneralId` on the `ledgers` table. All the data in the column will be lost.
  - Added the required column `accountGeneralAccountNumber` to the `accounts_detail` table without a default value. This is not possible if the table is not empty.
  - Added the required column `accountDetailAccountNumber` to the `ledgers` table without a default value. This is not possible if the table is not empty.
  - Added the required column `accountGeneralAccountNumber` to the `ledgers` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "public"."accounts_detail" DROP CONSTRAINT "accounts_detail_accountGeneralId_fkey";

-- DropForeignKey
ALTER TABLE "public"."ledgers" DROP CONSTRAINT "ledgers_accountDetailId_fkey";

-- DropForeignKey
ALTER TABLE "public"."ledgers" DROP CONSTRAINT "ledgers_accountGeneralId_fkey";

-- AlterTable
ALTER TABLE "public"."accounts_detail" DROP COLUMN "accountGeneralId",
ADD COLUMN     "accountGeneralAccountNumber" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "public"."ledgers" DROP COLUMN "accountDetailId",
DROP COLUMN "accountGeneralId",
ADD COLUMN     "accountDetailAccountNumber" TEXT NOT NULL,
ADD COLUMN     "accountGeneralAccountNumber" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "public"."accounts_detail" ADD CONSTRAINT "accounts_detail_accountGeneralAccountNumber_fkey" FOREIGN KEY ("accountGeneralAccountNumber") REFERENCES "public"."accounts_general"("accountNumber") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ledgers" ADD CONSTRAINT "ledgers_accountDetailAccountNumber_fkey" FOREIGN KEY ("accountDetailAccountNumber") REFERENCES "public"."accounts_detail"("accountNumber") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ledgers" ADD CONSTRAINT "ledgers_accountGeneralAccountNumber_fkey" FOREIGN KEY ("accountGeneralAccountNumber") REFERENCES "public"."accounts_general"("accountNumber") ON DELETE RESTRICT ON UPDATE CASCADE;
