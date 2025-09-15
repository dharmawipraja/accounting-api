/*
  Warnings:

  - The values [ASSET,HUTANG,MODAL,PENDAPATAN,BIAYA] on the enum `AccountCategory` will be removed. If these variants are still used in the database, this will fail.
  - The values [CREDIT] on the enum `TransactionType` will be removed. If these variants are still used in the database, this will fail.
  - Added the required column `accountSubCategory` to the `accounts_general` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "public"."AccountSubCategory" AS ENUM ('AKTIVA_LANCAR', 'AKTIVA_TETAP', 'AKTIVA_LAINNYA', 'HUTANG', 'MODAL', 'PENJUALAN', 'HARGA_POKOK_PENJUALAN', 'BEBAN_TETAP', 'BIAYA_TIDAK_TETAP', 'PENDAPATAN_DAN_BIAYA_LAINNYA', 'TAKSIRAN_PAJAK');

-- AlterEnum
BEGIN;
CREATE TYPE "public"."AccountCategory_new" AS ENUM ('AKTIVA', 'PASIVA', 'PENJUALAN', 'BEBAN_DAN_BIAYA');
ALTER TABLE "public"."accounts_general" ALTER COLUMN "accountCategory" TYPE "public"."AccountCategory_new" USING ("accountCategory"::text::"public"."AccountCategory_new");
ALTER TABLE "public"."accounts_detail" ALTER COLUMN "accountCategory" TYPE "public"."AccountCategory_new" USING ("accountCategory"::text::"public"."AccountCategory_new");
ALTER TYPE "public"."AccountCategory" RENAME TO "AccountCategory_old";
ALTER TYPE "public"."AccountCategory_new" RENAME TO "AccountCategory";
DROP TYPE "public"."AccountCategory_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "public"."TransactionType_new" AS ENUM ('DEBIT', 'KREDIT');
ALTER TABLE "public"."accounts_general" ALTER COLUMN "transactionType" TYPE "public"."TransactionType_new" USING ("transactionType"::text::"public"."TransactionType_new");
ALTER TABLE "public"."accounts_detail" ALTER COLUMN "transactionType" TYPE "public"."TransactionType_new" USING ("transactionType"::text::"public"."TransactionType_new");
ALTER TABLE "public"."ledgers" ALTER COLUMN "transactionType" TYPE "public"."TransactionType_new" USING ("transactionType"::text::"public"."TransactionType_new");
ALTER TYPE "public"."TransactionType" RENAME TO "TransactionType_old";
ALTER TYPE "public"."TransactionType_new" RENAME TO "TransactionType";
DROP TYPE "public"."TransactionType_old";
COMMIT;

-- AlterTable
ALTER TABLE "public"."accounts_general" ADD COLUMN     "accountSubCategory" "public"."AccountSubCategory" NOT NULL;
