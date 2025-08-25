/*
  Warnings:

  - Added the required column `accountDetailAccountNumber` to the `sisa_hasil_usaha` table without a default value. This is not possible if the table is not empty.
  - Added the required column `accountGeneralAccountNumber` to the `sisa_hasil_usaha` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "public"."sisa_hasil_usaha" ADD COLUMN     "accountDetailAccountNumber" TEXT NOT NULL,
ADD COLUMN     "accountGeneralAccountNumber" TEXT NOT NULL;
